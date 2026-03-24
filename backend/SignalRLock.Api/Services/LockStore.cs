using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using StackExchange.Redis;
using SignalRLock.Api.Models;

namespace SignalRLock.Api.Services;

public class LockStoreOptions
{
    public int LockTtlMs { get; set; } = 300_000;       // 5 minutes
    public int GracePeriodMs { get; set; } = 35_000;    // 35 seconds (must exceed SignalR auto-reconnect window of ~32s)
    public int HeartbeatIntervalMs { get; set; } = 30_000; // 30 seconds
}

public interface ILockStore
{
    /// <summary>
    /// Attempt to acquire a lock.  Returns (true, lock) if acquired or already owned by this user+connection.
    /// Returns (false, existingLock) if held by someone else.
    /// </summary>
    (bool Acquired, LockInfo? Lock) TryAcquire(string recordId, string userId, string displayName, string connectionId);

    /// <summary>Release a lock owned by the given connection.</summary>
    bool TryRelease(string recordId, string connectionId);

    /// <summary>Force-release any lock on the record (admin action).</summary>
    LockInfo? ForceRelease(string recordId);

    /// <summary>Refresh the TTL for an existing lock (heartbeat).</summary>
    bool TryHeartbeat(string recordId, string connectionId);

    /// <summary>Get the current lock, or null if not locked / expired.</summary>
    LockInfo? GetLock(string recordId);

    /// <summary>Return all records currently locked by a given connection.</summary>
    IReadOnlyList<string> GetRecordsLockedByConnection(string connectionId);

    /// <summary>Release all locks held by a connection (called on disconnect after grace period).</summary>
    IReadOnlyList<LockInfo> ReleaseAllByConnection(string connectionId);

    /// <summary>Return all currently active locks.</summary>
    IReadOnlyList<LockInfo> GetAllLocks();
}

public class RedisLockStore : ILockStore
{
    private readonly IConnectionMultiplexer _redis;
    private readonly IDatabase _db;
    private readonly LockStoreOptions _options;
    private readonly ILogger<RedisLockStore> _logger;
    private const string LockKeyPrefix = "lock:";
    private const string ConnectionLockKeyPrefix = "connection-locks:";

    public RedisLockStore(
        IConnectionMultiplexer redis,
        IOptions<LockStoreOptions> options,
        ILogger<RedisLockStore> logger)
    {
        _redis = redis;
        _db = redis.GetDatabase();
        _options = options.Value;
        _logger = logger;
    }

    public (bool Acquired, LockInfo? Lock) TryAcquire(
        string recordId, string userId, string displayName, string connectionId)
    {
        var lockKey = GetLockKey(recordId);
        var connectionLocksKey = GetConnectionLocksKey(connectionId);
        var ttl = TimeSpan.FromMilliseconds(_options.LockTtlMs);
        var now = DateTime.UtcNow;

        // Check if lock exists
        var existingValue = _db.StringGet(lockKey);
        
        if (existingValue.HasValue)
        {
            var existingLock = JsonSerializer.Deserialize<LockInfo>(existingValue.ToString());
            
            // Idempotent: same owner re-acquires (rolls TTL)
            if (existingLock?.LockedByUserId == userId)
            {
                var refreshed = existingLock with 
                { 
                    ExpiresAtUtc = now + ttl,
                    ConnectionId = connectionId 
                };
                var json = JsonSerializer.Serialize(refreshed);
                _db.StringSet(lockKey, json, ttl);
                _db.SetAdd(connectionLocksKey, recordId);
                _logger.LogInformation("Lock on record {RecordId} refreshed for user {UserId}.", recordId, userId);
                return (true, refreshed);
            }

            // Held by someone else
            return (false, existingLock);
        }

        // Not locked — create new lock
        var newLock = new LockInfo
        {
            RecordId = recordId,
            LockedByUserId = userId,
            LockedByDisplayName = displayName,
            AcquiredAtUtc = now,
            ExpiresAtUtc = now + ttl,
            ConnectionId = connectionId
        };

        var lockJson = JsonSerializer.Serialize(newLock);
        _db.StringSet(lockKey, lockJson, ttl);
        _db.SetAdd(connectionLocksKey, recordId);
        _logger.LogInformation("Lock acquired on record {RecordId} by user {UserId}.", recordId, userId);
        return (true, newLock);
    }

    public bool TryRelease(string recordId, string connectionId)
    {
        var lockKey = GetLockKey(recordId);
        var existingValue = _db.StringGet(lockKey);

        if (existingValue.HasValue)
        {
            var existingLock = JsonSerializer.Deserialize<LockInfo>(existingValue.ToString());
            if (existingLock?.ConnectionId == connectionId)
            {
                _db.KeyDelete(lockKey);
                _db.SetRemove(GetConnectionLocksKey(connectionId), recordId);
                _logger.LogInformation("Lock released on record {RecordId} by connection {ConnectionId}.", recordId, connectionId);
                return true;
            }
        }
        return false;
    }

    public LockInfo? ForceRelease(string recordId)
    {
        var lockKey = GetLockKey(recordId);
        var existingValue = _db.StringGet(lockKey);

        if (existingValue.HasValue)
        {
            var existingLock = JsonSerializer.Deserialize<LockInfo>(existingValue.ToString());
            _db.KeyDelete(lockKey);
            if (existingLock != null)
            {
                _db.SetRemove(GetConnectionLocksKey(existingLock.ConnectionId), recordId);
            }
            _logger.LogInformation("Lock force-released on record {RecordId}.", recordId);
            return existingLock;
        }
        return null;
    }

    public bool TryHeartbeat(string recordId, string connectionId)
    {
        var lockKey = GetLockKey(recordId);
        var existingValue = _db.StringGet(lockKey);

        if (!existingValue.HasValue)
            return false;

        var existingLock = JsonSerializer.Deserialize<LockInfo>(existingValue.ToString());
        if (existingLock?.ConnectionId != connectionId)
            return false;

        var ttl = TimeSpan.FromMilliseconds(_options.LockTtlMs);
        var refreshed = existingLock with
        {
            ExpiresAtUtc = DateTime.UtcNow + ttl
        };
        var json = JsonSerializer.Serialize(refreshed);
        _db.StringSet(lockKey, json, ttl, When.Exists);
        return true;
    }

    public LockInfo? GetLock(string recordId)
    {
        var lockKey = GetLockKey(recordId);
        var value = _db.StringGet(lockKey);

        if (value.HasValue)
        {
            var lockInfo = JsonSerializer.Deserialize<LockInfo>(value.ToString());
            return lockInfo;
        }
        return null;
    }

    public IReadOnlyList<string> GetRecordsLockedByConnection(string connectionId)
    {
        var connectionLocksKey = GetConnectionLocksKey(connectionId);
        var recordIds = _db.SetMembers(connectionLocksKey);
        return recordIds.Select(r => r.ToString()).ToList();
    }

    public IReadOnlyList<LockInfo> ReleaseAllByConnection(string connectionId)
    {
        var released = new List<LockInfo>();
        var connectionLocksKey = GetConnectionLocksKey(connectionId);
        var recordIds = _db.SetMembers(connectionLocksKey);

        foreach (var recordId in recordIds)
        {
            var lockKey = GetLockKey(recordId.ToString());
            var existingValue = _db.StringGet(lockKey);
            
            if (existingValue.HasValue)
            {
                var lockInfo = JsonSerializer.Deserialize<LockInfo>(existingValue.ToString());
                if (lockInfo != null)
                {
                    released.Add(lockInfo);
                    _logger.LogInformation("Lock released on record {RecordId} due to connection {ConnectionId} disconnect.", recordId, connectionId);
                }
            }
            _db.KeyDelete(lockKey);
        }

        _db.KeyDelete(connectionLocksKey);
        return released;
    }

    public IReadOnlyList<LockInfo> GetAllLocks()
    {
        var server = _redis.GetServers().First();
        var keys = server.Keys(pattern: $"{LockKeyPrefix}*");
        var locks = new List<LockInfo>();

        foreach (var key in keys)
        {
            var value = _db.StringGet(key);
            if (value.HasValue)
            {
                var lockInfo = JsonSerializer.Deserialize<LockInfo>(value.ToString());
                if (lockInfo != null)
                    locks.Add(lockInfo);
            }
        }

        return locks;
    }

    private string GetLockKey(string recordId) => $"{LockKeyPrefix}{recordId}";

    private string GetConnectionLocksKey(string connectionId) => $"{ConnectionLockKeyPrefix}{connectionId}";
}
