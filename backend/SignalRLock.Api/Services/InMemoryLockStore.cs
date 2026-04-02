using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using SignalRLock.Api.Models;

namespace SignalRLock.Api.Services;

/// <summary>
/// In-memory lock store for testing and development.
/// Stores locks with TTL expiration tracking.
/// </summary>
public class InMemoryLockStore : ILockStore
{
    private readonly ConcurrentDictionary<string, (LockInfo Lock, DateTime ExpiresAtUtc)> _locks = new();
    private readonly ConcurrentDictionary<string, HashSet<string>> _connectionLocks = new();
    private readonly LockStoreOptions _options;
    private readonly ILogger<InMemoryLockStore> _logger;

    public InMemoryLockStore(
        IOptions<LockStoreOptions> options,
        ILogger<InMemoryLockStore> logger)
    {
        _options = options.Value;
        _logger = logger;
    }

    public Task<(bool Acquired, LockInfo? Lock)> TryAcquireAsync(
        string featureKey, string recordId, string userId, string displayName,
        string connectionId, TimeSpan lockTtl)
    {
        var now = DateTime.UtcNow;
        var lockKey = GetLockKey(featureKey, recordId);
        var connectionLocksKey = GetConnectionLocksKey(featureKey, connectionId);

        (bool Acquired, LockInfo? Lock) result;

        if (_locks.TryGetValue(lockKey, out var existing))
        {
            var (existingLock, expiresAt) = existing;

            // Check if lock has expired
            if (now > expiresAt)
            {
                var newLock = new LockInfo
                {
                    RecordId = recordId,
                    LockedByUserId = userId,
                    LockedByDisplayName = displayName,
                    AcquiredAtUtc = now,
                    ExpiresAtUtc = now + lockTtl,
                    ConnectionId = connectionId
                };
                _locks[lockKey] = (newLock, now + lockTtl);
                _connectionLocks.AddOrUpdate(connectionLocksKey,
                    new HashSet<string> { recordId },
                    (_, set) => { set.Add(recordId); return set; });
                result = (true, newLock);
            }
            // Idempotent: same owner re-acquires
            else if (existingLock.LockedByUserId == userId)
            {
                var refreshed = existingLock with
                {
                    ExpiresAtUtc = now + lockTtl,
                    ConnectionId = connectionId
                };
                _locks[lockKey] = (refreshed, now + lockTtl);
                _connectionLocks.AddOrUpdate(connectionLocksKey,
                    new HashSet<string> { recordId },
                    (_, set) => { set.Add(recordId); return set; });
                _logger.LogInformation(
                    "Lock refreshed: feature={Feature} record={RecordId} user={UserId}",
                    featureKey, recordId, userId);
                result = (true, refreshed);
            }
            // Held by someone else
            else
            {
                result = (false, existingLock);
            }
        }
        else
        {
            // Lock doesn't exist - create new lock
            var newLock = new LockInfo
            {
                RecordId = recordId,
                LockedByUserId = userId,
                LockedByDisplayName = displayName,
                AcquiredAtUtc = now,
                ExpiresAtUtc = now + lockTtl,
                ConnectionId = connectionId
            };
            _locks[lockKey] = (newLock, now + lockTtl);
            _connectionLocks.AddOrUpdate(connectionLocksKey,
                new HashSet<string> { recordId },
                (_, set) => { set.Add(recordId); return set; });
            _logger.LogInformation(
                "Lock acquired: feature={Feature} record={RecordId} user={UserId}",
                featureKey, recordId, userId);
            result = (true, newLock);
        }

        return Task.FromResult(result);
    }

    public Task<bool> TryReleaseAsync(string featureKey, string recordId, string connectionId)
    {
        var lockKey = GetLockKey(featureKey, recordId);

        if (_locks.TryGetValue(lockKey, out var entry))
        {
            if (entry.Lock.ConnectionId == connectionId)
            {
                _locks.Remove(lockKey, out _);
                var connectionLocksKey = GetConnectionLocksKey(featureKey, connectionId);
                if (_connectionLocks.TryGetValue(connectionLocksKey, out var set))
                {
                    set.Remove(recordId);
                }
                _logger.LogInformation(
                    "Lock released: feature={Feature} record={RecordId} conn={ConnectionId}",
                    featureKey, recordId, connectionId);
                return Task.FromResult(true);
            }
        }
        return Task.FromResult(false);
    }

    public Task<LockInfo?> ForceReleaseAsync(string featureKey, string recordId)
    {
        var lockKey = GetLockKey(featureKey, recordId);

        if (_locks.TryRemove(lockKey, out var entry))
        {
            var connectionLocksKey = GetConnectionLocksKey(featureKey, entry.Lock.ConnectionId);
            if (_connectionLocks.TryGetValue(connectionLocksKey, out var set))
            {
                set.Remove(recordId);
            }
            _logger.LogInformation(
                "Lock force-released: feature={Feature} record={RecordId}", featureKey, recordId);
            return Task.FromResult((LockInfo?)entry.Lock);
        }
        return Task.FromResult((LockInfo?)null);
    }

    public Task<bool> TryHeartbeatAsync(string featureKey, string recordId, string connectionId, TimeSpan lockTtl)
    {
        var lockKey = GetLockKey(featureKey, recordId);

        if (_locks.TryGetValue(lockKey, out var entry))
        {
            if (entry.Lock.ConnectionId == connectionId)
            {
                var refreshed = entry.Lock with
                {
                    ExpiresAtUtc = DateTime.UtcNow + lockTtl
                };
                _locks[lockKey] = (refreshed, DateTime.UtcNow + lockTtl);
                return Task.FromResult(true);
            }
        }
        return Task.FromResult(false);
    }

    public Task<LockInfo?> GetLockAsync(string featureKey, string recordId)
    {
        var lockKey = GetLockKey(featureKey, recordId);

        if (_locks.TryGetValue(lockKey, out var entry))
        {
            if (DateTime.UtcNow <= entry.ExpiresAtUtc)
            {
                return Task.FromResult((LockInfo?)entry.Lock);
            }
            // Expired, remove it
            _locks.Remove(lockKey, out _);
        }
        return Task.FromResult((LockInfo?)null);
    }

    public Task<IReadOnlyList<string>> GetRecordsLockedByConnectionAsync(string featureKey, string connectionId)
    {
        var connectionLocksKey = GetConnectionLocksKey(featureKey, connectionId);
        var records = _connectionLocks.TryGetValue(connectionLocksKey, out var set)
            ? (IReadOnlyList<string>)set.ToList()
            : new List<string>();
        return Task.FromResult(records);
    }

    public Task<IReadOnlyList<LockInfo>> ReleaseAllByConnectionAsync(string featureKey, string connectionId)
    {
        var released = new List<LockInfo>();
        var connectionLocksKey = GetConnectionLocksKey(featureKey, connectionId);

        if (_connectionLocks.TryRemove(connectionLocksKey, out var recordIds))
        {
            foreach (var recordId in recordIds)
            {
                var lockKey = GetLockKey(featureKey, recordId);
                if (_locks.TryRemove(lockKey, out var entry))
                {
                    released.Add(entry.Lock);
                    _logger.LogInformation(
                        "Lock released on disconnect: feature={Feature} record={RecordId} conn={ConnectionId}",
                        featureKey, recordId, connectionId);
                }
            }
        }

        return Task.FromResult((IReadOnlyList<LockInfo>)released);
    }

    public Task<IReadOnlyList<LockInfo>> GetAllLocksAsync(string featureKey)
    {
        var now = DateTime.UtcNow;
        var locks = new List<LockInfo>();

        foreach (var kvp in _locks)
        {
            if (kvp.Key.StartsWith($"{GetLockKeyPrefix(featureKey)}"))
            {
                if (now <= kvp.Value.ExpiresAtUtc)
                {
                    locks.Add(kvp.Value.Lock);
                }
            }
        }

        return Task.FromResult((IReadOnlyList<LockInfo>)locks);
    }

    private static string GetLockKey(string featureKey, string recordId) =>
        $"lock:{featureKey}:{recordId}";

    private static string GetLockKeyPrefix(string featureKey) =>
        $"lock:{featureKey}:";

    private static string GetConnectionLocksKey(string featureKey, string connectionId) =>
        $"connection-locks:{featureKey}:{connectionId}";
}
