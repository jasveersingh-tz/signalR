using System.Text.Json;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;
using SignalRLock.Api.Models;

namespace SignalRLock.Api.Services;

/// <summary>
/// Timing options for the locking system.
/// Used as the shape for both the Default block and each per-feature block in LockFeaturesConfig.
/// </summary>
public class LockStoreOptions
{
    public int LockTtlMs { get; set; } = 300_000;          // 5 minutes
    public int GracePeriodMs { get; set; } = 35_000;       // 35 s (must exceed SignalR auto-reconnect ~32 s)
    public int HeartbeatIntervalMs { get; set; } = 30_000; // 30 s
}

public interface ILockStore
{
    /// <summary>
    /// Attempt to acquire a lock. Returns (true, lock) if acquired or already owned by this user.
    /// Returns (false, existingLock) if held by someone else.
    /// <paramref name="lockTtl"/> comes from the feature handler's options.
    /// </summary>
    (bool Acquired, LockInfo? Lock) TryAcquire(
        string featureKey, string recordId, string userId, string displayName,
        string connectionId, TimeSpan lockTtl);

    /// <summary>Release a lock owned by the given connection.</summary>
    bool TryRelease(string featureKey, string recordId, string connectionId);

    /// <summary>Force-release any lock on the record regardless of owner (admin action).</summary>
    LockInfo? ForceRelease(string featureKey, string recordId);

    /// <summary>Refresh the TTL for an existing lock (heartbeat).</summary>
    bool TryHeartbeat(string featureKey, string recordId, string connectionId, TimeSpan lockTtl);

    /// <summary>Get the current lock, or null if not locked / expired.</summary>
    LockInfo? GetLock(string featureKey, string recordId);

    /// <summary>Return all record IDs currently locked by a given connection under this feature.</summary>
    IReadOnlyList<string> GetRecordsLockedByConnection(string featureKey, string connectionId);

    /// <summary>Release all locks held by a connection under this feature (called after grace period).</summary>
    IReadOnlyList<LockInfo> ReleaseAllByConnection(string featureKey, string connectionId);

    /// <summary>Return all currently active locks for a feature (used by REST bootstrap).</summary>
    IReadOnlyList<LockInfo> GetAllLocks(string featureKey);
}

public class RedisLockStore(
    IConnectionMultiplexer redis,
    ILogger<RedisLockStore> logger) : ILockStore
{
    private readonly IConnectionMultiplexer _redis = redis;
    private readonly IDatabase _db = redis.GetDatabase();
    private readonly ILogger<RedisLockStore> _logger = logger;

    // Key format:  lock:{featureKey}:{recordId}
    // Keeping featureKey in the key namespace means locks are fully isolated per feature
    // and you can scan/flush them independently.
    private const string LockKeyPrefix = "lock";
    private const string ConnectionLockKeyPrefix = "connection-locks";

    public (bool Acquired, LockInfo? Lock) TryAcquire(
        string featureKey, string recordId, string userId, string displayName,
        string connectionId, TimeSpan lockTtl)
    {
        var lockKey = GetLockKey(featureKey, recordId);
        var connectionLocksKey = GetConnectionLocksKey(featureKey, connectionId);
        var now = DateTime.UtcNow;

        var existingValue = _db.StringGet(lockKey);

        if (existingValue.HasValue)
        {
            var existingLock = JsonSerializer.Deserialize<LockInfo>(existingValue.ToString());

            // Idempotent: same owner re-acquires (rolls TTL, updates connectionId for reconnect)
            if (existingLock?.LockedByUserId == userId)
            {
                var refreshed = existingLock with
                {
                    ExpiresAtUtc = now + lockTtl,
                    ConnectionId = connectionId
                };
                _db.StringSet(lockKey, JsonSerializer.Serialize(refreshed), lockTtl);
                _db.SetAdd(connectionLocksKey, recordId);
                _logger.LogInformation(
                    "Lock refreshed: feature={Feature} record={RecordId} user={UserId}",
                    featureKey, recordId, userId);
                return (true, refreshed);
            }

            return (false, existingLock);
        }

        var newLock = new LockInfo
        {
            RecordId = recordId,
            LockedByUserId = userId,
            LockedByDisplayName = displayName,
            AcquiredAtUtc = now,
            ExpiresAtUtc = now + lockTtl,
            ConnectionId = connectionId
        };

        _db.StringSet(lockKey, JsonSerializer.Serialize(newLock), lockTtl);
        _db.SetAdd(connectionLocksKey, recordId);
        _logger.LogInformation(
            "Lock acquired: feature={Feature} record={RecordId} user={UserId}",
            featureKey, recordId, userId);
        return (true, newLock);
    }

    public bool TryRelease(string featureKey, string recordId, string connectionId)
    {
        var lockKey = GetLockKey(featureKey, recordId);
        var existingValue = _db.StringGet(lockKey);

        if (existingValue.HasValue)
        {
            var existingLock = JsonSerializer.Deserialize<LockInfo>(existingValue.ToString());
            if (existingLock?.ConnectionId == connectionId)
            {
                _db.KeyDelete(lockKey);
                _db.SetRemove(GetConnectionLocksKey(featureKey, connectionId), recordId);
                _logger.LogInformation(
                    "Lock released: feature={Feature} record={RecordId} conn={ConnectionId}",
                    featureKey, recordId, connectionId);
                return true;
            }
        }
        return false;
    }

    public LockInfo? ForceRelease(string featureKey, string recordId)
    {
        var lockKey = GetLockKey(featureKey, recordId);
        var existingValue = _db.StringGet(lockKey);

        if (existingValue.HasValue)
        {
            var existingLock = JsonSerializer.Deserialize<LockInfo>(existingValue.ToString());
            _db.KeyDelete(lockKey);
            if (existingLock != null)
                _db.SetRemove(GetConnectionLocksKey(featureKey, existingLock.ConnectionId), recordId);

            _logger.LogInformation(
                "Lock force-released: feature={Feature} record={RecordId}", featureKey, recordId);
            return existingLock;
        }
        return null;
    }

    public bool TryHeartbeat(string featureKey, string recordId, string connectionId, TimeSpan lockTtl)
    {
        var lockKey = GetLockKey(featureKey, recordId);
        var existingValue = _db.StringGet(lockKey);

        if (!existingValue.HasValue) return false;

        var existingLock = JsonSerializer.Deserialize<LockInfo>(existingValue.ToString());
        if (existingLock?.ConnectionId != connectionId) return false;

        var refreshed = existingLock with { ExpiresAtUtc = DateTime.UtcNow + lockTtl };
        _db.StringSet(lockKey, JsonSerializer.Serialize(refreshed), lockTtl, When.Exists);
        return true;
    }

    public LockInfo? GetLock(string featureKey, string recordId)
    {
        var value = _db.StringGet(GetLockKey(featureKey, recordId));
        return value.HasValue
            ? JsonSerializer.Deserialize<LockInfo>(value.ToString())
            : null;
    }

    public IReadOnlyList<string> GetRecordsLockedByConnection(string featureKey, string connectionId)
    {
        var members = _db.SetMembers(GetConnectionLocksKey(featureKey, connectionId));
        return members.Select(m => m.ToString()).ToList();
    }

    public IReadOnlyList<LockInfo> ReleaseAllByConnection(string featureKey, string connectionId)
    {
        List<LockInfo> released = [];
        var connectionLocksKey = GetConnectionLocksKey(featureKey, connectionId);

        foreach (var recordId in _db.SetMembers(connectionLocksKey))
        {
            var lockKey = GetLockKey(featureKey, recordId.ToString());
            var existingValue = _db.StringGet(lockKey);
            if (existingValue.HasValue)
            {
                var lockInfo = JsonSerializer.Deserialize<LockInfo>(existingValue.ToString());
                if (lockInfo != null)
                {
                    released.Add(lockInfo);
                    _logger.LogInformation(
                        "Lock released on disconnect: feature={Feature} record={RecordId} conn={ConnectionId}",
                        featureKey, recordId, connectionId);
                }
            }
            _db.KeyDelete(lockKey);
        }

        _db.KeyDelete(connectionLocksKey);
        return released;
    }

    public IReadOnlyList<LockInfo> GetAllLocks(string featureKey)
    {
        var server = _redis.GetServers().First();
        var pattern = $"{LockKeyPrefix}:{featureKey}:*";
        var locks = new List<LockInfo>();

        foreach (var key in server.Keys(pattern: pattern))
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

    // ── Key helpers ───────────────────────────────────────────────────────────

    private static string GetLockKey(string featureKey, string recordId) =>
        $"{LockKeyPrefix}:{featureKey}:{recordId}";

    private static string GetConnectionLocksKey(string featureKey, string connectionId) =>
        $"{ConnectionLockKeyPrefix}:{featureKey}:{connectionId}";
}
