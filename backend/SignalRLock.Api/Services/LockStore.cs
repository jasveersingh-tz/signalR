using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using StackExchange.Redis;
using SignalRLock.Api.Models;

namespace SignalRLock.Api.Services;

public class LockStoreOptions
{
    public int LockTtlMs { get; set; } = 300_000;       // 5 minutes
    public int GracePeriodMs { get; set; } = 20_000;    // 20 seconds
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

    /// <summary>Release a lock if it is owned by the given user.</summary>
    bool TryReleaseByUser(string recordId, string userId);

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

    // ── Lock transfer ──────────────────────────────────────────────────────────

    /// <summary>
    /// Store a pending lock transfer request.
    /// Returns (true, false) on success.
    /// Returns (false, true) if a cooldown is active (blocked).
    /// Returns (false, false) if a request from another user is already pending.
    /// </summary>
    (bool Stored, bool InCooldown) TrySetTransferRequest(
        string recordId, string requestingUserId, string requestingDisplayName, string requestingConnectionId);

    /// <summary>Get the pending transfer request for a record, or null if none.</summary>
    LockTransferRequest? GetTransferRequest(string recordId);

    /// <summary>Remove the pending transfer request (called on approve or reject).</summary>
    void ClearTransferRequest(string recordId);

    /// <summary>Activate a cooldown that blocks new transfer requests for the given duration.</summary>
    void SetTransferCooldown(string recordId, int cooldownMs);

    /// <summary>Returns whether a cooldown is active and how many seconds remain.</summary>
    (bool Active, long RemainingSeconds) IsTransferCooldownActive(string recordId);
}

public class RedisLockStore : ILockStore
{
    private readonly IConnectionMultiplexer _redis;
    private readonly IDatabase _db;
    private readonly LockStoreOptions _options;
    private readonly ILogger<RedisLockStore> _logger;
    private const string LockKeyPrefix = "lock:";
    private const string ConnectionLockKeyPrefix = "connection-locks:";
    private const string TransferRequestKeyPrefix = "transfer-request:";
    private const string TransferCooldownKeyPrefix = "transfer-cooldown:";
    private const int TransferRequestTtlMs = 180_000; // 3 minutes — stale requests self-clean

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

    public bool TryReleaseByUser(string recordId, string userId)
    {
        var lockKey = GetLockKey(recordId);
        var existingValue = _db.StringGet(lockKey);

        if (existingValue.HasValue)
        {
            var existingLock = JsonSerializer.Deserialize<LockInfo>(existingValue.ToString());
            if (existingLock?.LockedByUserId == userId)
            {
                _db.KeyDelete(lockKey);
                _db.SetRemove(GetConnectionLocksKey(existingLock.ConnectionId), recordId);
                _logger.LogInformation("Lock released on record {RecordId} by user {UserId}.", recordId, userId);
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

    private string GetLockKey(string recordId) => $"{LockKeyPrefix}{recordId}";

    private string GetConnectionLocksKey(string connectionId) => $"{ConnectionLockKeyPrefix}{connectionId}";

    // ── Lock transfer implementation ──────────────────────────────────────────

    public (bool Stored, bool InCooldown) TrySetTransferRequest(
        string recordId, string requestingUserId, string requestingDisplayName, string requestingConnectionId)
    {
        // Abort if cooldown is active
        if (_db.KeyExists(GetTransferCooldownKey(recordId)))
            return (false, true);

        var requestKey = GetTransferRequestKey(recordId);

        // Abort if another (different) request is already pending
        var existing = _db.StringGet(requestKey);
        if (existing.HasValue)
        {
            var existingRequest = JsonSerializer.Deserialize<LockTransferRequest>(existing.ToString());
            if (existingRequest?.RequestingUserId != requestingUserId)
                return (false, false); // already another pending request
        }

        var request = new LockTransferRequest
        {
            RecordId = recordId,
            RequestingUserId = requestingUserId,
            RequestingDisplayName = requestingDisplayName,
            RequestingConnectionId = requestingConnectionId,
            RequestedAtUtc = DateTime.UtcNow,
        };

        _db.StringSet(requestKey, JsonSerializer.Serialize(request),
            TimeSpan.FromMilliseconds(TransferRequestTtlMs));

        _logger.LogInformation("Transfer request stored for record {RecordId} from user {UserId}.", recordId, requestingUserId);
        return (true, false);
    }

    public LockTransferRequest? GetTransferRequest(string recordId)
    {
        var value = _db.StringGet(GetTransferRequestKey(recordId));
        return value.HasValue ? JsonSerializer.Deserialize<LockTransferRequest>(value.ToString()) : null;
    }

    public void ClearTransferRequest(string recordId)
        => _db.KeyDelete(GetTransferRequestKey(recordId));

    public void SetTransferCooldown(string recordId, int cooldownMs)
    {
        _db.StringSet(GetTransferCooldownKey(recordId), "1", TimeSpan.FromMilliseconds(cooldownMs));
        _logger.LogInformation("Transfer cooldown set for record {RecordId} ({CooldownMs}ms).", recordId, cooldownMs);
    }

    public (bool Active, long RemainingSeconds) IsTransferCooldownActive(string recordId)
    {
        var ttl = _db.KeyTimeToLive(GetTransferCooldownKey(recordId));
        if (ttl is null || ttl.Value <= TimeSpan.Zero)
            return (false, 0);
        return (true, (long)Math.Ceiling(ttl.Value.TotalSeconds));
    }

    private string GetTransferRequestKey(string recordId) => $"{TransferRequestKeyPrefix}{recordId}";
    private string GetTransferCooldownKey(string recordId) => $"{TransferCooldownKeyPrefix}{recordId}";
}
