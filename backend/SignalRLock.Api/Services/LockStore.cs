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
    Task<(bool Acquired, LockInfo? Lock)> TryAcquireAsync(
        string featureKey, string recordId, string userId, string displayName,
        string connectionId, TimeSpan lockTtl);

    /// <summary>Release a lock owned by the given connection.</summary>
    Task<bool> TryReleaseAsync(string featureKey, string recordId, string connectionId);

    /// <summary>Force-release any lock on the record regardless of owner (admin action).</summary>
    Task<LockInfo?> ForceReleaseAsync(string featureKey, string recordId);

    /// <summary>Refresh the TTL for an existing lock (heartbeat).</summary>
    Task<bool> TryHeartbeatAsync(string featureKey, string recordId, string connectionId, TimeSpan lockTtl);

    /// <summary>Get the current lock, or null if not locked / expired.</summary>
    Task<LockInfo?> GetLockAsync(string featureKey, string recordId);

    /// <summary>Return all record IDs currently locked by a given connection under this feature.</summary>
    Task<IReadOnlyList<string>> GetRecordsLockedByConnectionAsync(string featureKey, string connectionId);

    /// <summary>Release all locks held by a connection under this feature (called after grace period).</summary>
    Task<IReadOnlyList<LockInfo>> ReleaseAllByConnectionAsync(string featureKey, string connectionId);

    /// <summary>Return all currently active locks for a feature (used by REST bootstrap).</summary>
    Task<IReadOnlyList<LockInfo>> GetAllLocksAsync(string featureKey);
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

    public async Task<(bool Acquired, LockInfo? Lock)> TryAcquireAsync(
        string featureKey, string recordId, string userId, string displayName,
        string connectionId, TimeSpan lockTtl)
    {
        var lockKey = GetLockKey(featureKey, recordId);
        var connectionLocksKey = GetConnectionLocksKey(featureKey, connectionId);
        var now = DateTime.UtcNow;

        var existingValue = await _db.StringGetAsync(lockKey);

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
                await _db.StringSetAsync(lockKey, JsonSerializer.Serialize(refreshed), lockTtl);
                // If the connection changed (e.g. duplicate tab), clean up the old connection's
                // tracking set to prevent its disconnect handler from evicting this lock.
                if (existingLock.ConnectionId != connectionId)
                    await _db.SetRemoveAsync(GetConnectionLocksKey(featureKey, existingLock.ConnectionId), recordId);
                await _db.SetAddAsync(connectionLocksKey, recordId);
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

        await _db.StringSetAsync(lockKey, JsonSerializer.Serialize(newLock), lockTtl);
        await _db.SetAddAsync(connectionLocksKey, recordId);
        _logger.LogInformation(
            "Lock acquired: feature={Feature} record={RecordId} user={UserId}",
            featureKey, recordId, userId);
        return (true, newLock);
    }

    public async Task<bool> TryReleaseAsync(string featureKey, string recordId, string connectionId)
    {
        var lockKey = GetLockKey(featureKey, recordId);
        var existingValue = await _db.StringGetAsync(lockKey);

        if (existingValue.HasValue)
        {
            var existingLock = JsonSerializer.Deserialize<LockInfo>(existingValue.ToString());
            if (existingLock?.ConnectionId == connectionId)
            {
                await _db.KeyDeleteAsync(lockKey);
                await _db.SetRemoveAsync(GetConnectionLocksKey(featureKey, connectionId), recordId);
                _logger.LogInformation(
                    "Lock released: feature={Feature} record={RecordId} conn={ConnectionId}",
                    featureKey, recordId, connectionId);
                return true;
            }
        }
        return false;
    }

    public async Task<LockInfo?> ForceReleaseAsync(string featureKey, string recordId)
    {
        var lockKey = GetLockKey(featureKey, recordId);
        var existingValue = await _db.StringGetAsync(lockKey);

        if (existingValue.HasValue)
        {
            var existingLock = JsonSerializer.Deserialize<LockInfo>(existingValue.ToString());
            await _db.KeyDeleteAsync(lockKey);
            if (existingLock != null)
                await _db.SetRemoveAsync(GetConnectionLocksKey(featureKey, existingLock.ConnectionId), recordId);

            _logger.LogInformation(
                "Lock force-released: feature={Feature} record={RecordId}", featureKey, recordId);
            return existingLock;
        }
        return null;
    }

    public async Task<bool> TryHeartbeatAsync(string featureKey, string recordId, string connectionId, TimeSpan lockTtl)
    {
        var lockKey = GetLockKey(featureKey, recordId);
        var existingValue = await _db.StringGetAsync(lockKey);

        if (!existingValue.HasValue) return false;

        var existingLock = JsonSerializer.Deserialize<LockInfo>(existingValue.ToString());
        if (existingLock?.ConnectionId != connectionId) return false;

        var refreshed = existingLock with { ExpiresAtUtc = DateTime.UtcNow + lockTtl };
        await _db.StringSetAsync(lockKey, JsonSerializer.Serialize(refreshed), lockTtl, When.Exists);
        return true;
    }

    public async Task<LockInfo?> GetLockAsync(string featureKey, string recordId)
    {
        var value = await _db.StringGetAsync(GetLockKey(featureKey, recordId));
        return value.HasValue
            ? JsonSerializer.Deserialize<LockInfo>(value.ToString())
            : null;
    }

    public async Task<IReadOnlyList<string>> GetRecordsLockedByConnectionAsync(string featureKey, string connectionId)
    {
        var members = await _db.SetMembersAsync(GetConnectionLocksKey(featureKey, connectionId));
        return members.Select(m => m.ToString()).ToList();
    }

    public async Task<IReadOnlyList<LockInfo>> ReleaseAllByConnectionAsync(string featureKey, string connectionId)
    {
        List<LockInfo> released = [];
        var connectionLocksKey = GetConnectionLocksKey(featureKey, connectionId);

        var recordIds = await _db.SetMembersAsync(connectionLocksKey);
        foreach (var recordId in recordIds)
        {
            var lockKey = GetLockKey(featureKey, recordId.ToString());
            var existingValue = await _db.StringGetAsync(lockKey);
            if (existingValue.HasValue)
            {
                var lockInfo = JsonSerializer.Deserialize<LockInfo>(existingValue.ToString());
                // Only release if this connection still owns the lock — a re-acquire by the same
                // user from a new connection may have already transferred ownership.
                if (lockInfo != null && lockInfo.ConnectionId == connectionId)
                {
                    released.Add(lockInfo);
                    await _db.KeyDeleteAsync(lockKey);
                    _logger.LogInformation(
                        "Lock released on disconnect: feature={Feature} record={RecordId} conn={ConnectionId}",
                        featureKey, recordId, connectionId);
                }
                else if (lockInfo != null)
                {
                    _logger.LogInformation(
                        "Skipping disconnect release: feature={Feature} record={RecordId} lock now owned by conn={OwnerConn}",
                        featureKey, recordId, lockInfo.ConnectionId);
                }
            }
        }

        await _db.KeyDeleteAsync(connectionLocksKey);
        return released;
    }

    public async Task<IReadOnlyList<LockInfo>> GetAllLocksAsync(string featureKey)
    {
        // Note: server.Keys() is synchronous, so we wrap it in Task.Run to avoid blocking the thread pool
        var locks = await Task.Run(() =>
        {
            var server = _redis.GetServers().First();
            var pattern = $"{LockKeyPrefix}:{featureKey}:*";
            var result = new List<LockInfo>();

            foreach (var key in server.Keys(pattern: pattern))
            {
                // Use synchronous get here since we're already in Task.Run
                var value = _db.StringGet(key);
                if (value.HasValue)
                {
                    var lockInfo = JsonSerializer.Deserialize<LockInfo>(value.ToString());
                    if (lockInfo != null)
                        result.Add(lockInfo);
                }
            }

            return result;
        });

        return locks;
    }

    // ── Key helpers ───────────────────────────────────────────────────────────

    private static string GetLockKey(string featureKey, string recordId) =>
        $"{LockKeyPrefix}:{featureKey}:{recordId}";

    private static string GetConnectionLocksKey(string featureKey, string connectionId) =>
        $"{ConnectionLockKeyPrefix}:{featureKey}:{connectionId}";
}
