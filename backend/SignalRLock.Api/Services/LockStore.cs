using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
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
}

public class InMemoryLockStore : ILockStore
{
    private readonly ConcurrentDictionary<string, LockInfo> _locks = new(StringComparer.OrdinalIgnoreCase);
    private readonly LockStoreOptions _options;
    private readonly ILogger<InMemoryLockStore> _logger;

    public InMemoryLockStore(IOptions<LockStoreOptions> options, ILogger<InMemoryLockStore> logger)
    {
        _options = options.Value;
        _logger = logger;
    }

    public (bool Acquired, LockInfo? Lock) TryAcquire(
        string recordId, string userId, string displayName, string connectionId)
    {
        var now = DateTime.UtcNow;
        var ttl = TimeSpan.FromMilliseconds(_options.LockTtlMs);

        while (true)
        {
            if (_locks.TryGetValue(recordId, out var existing))
            {
                // Expired lock — evict and retry
                if (existing.ExpiresAtUtc < now)
                {
                    if (_locks.TryRemove(recordId, out _))
                    {
                        _logger.LogInformation("Lock on record {RecordId} evicted (TTL expired).", recordId);
                    }
                    continue;
                }

                // Idempotent: same owner re-acquires (rolls TTL)
                if (existing.LockedByUserId == userId)
                {
                    var refreshed = existing with { ExpiresAtUtc = now + ttl, ConnectionId = connectionId };
                    _locks.TryUpdate(recordId, refreshed, existing);
                    _logger.LogInformation("Lock on record {RecordId} refreshed for user {UserId}.", recordId, userId);
                    return (true, _locks.GetValueOrDefault(recordId));
                }

                // Held by someone else
                return (false, existing);
            }

            // Not locked — try to add atomically
            var newLock = new LockInfo
            {
                RecordId = recordId,
                LockedByUserId = userId,
                LockedByDisplayName = displayName,
                AcquiredAtUtc = now,
                ExpiresAtUtc = now + ttl,
                ConnectionId = connectionId
            };

            if (_locks.TryAdd(recordId, newLock))
            {
                _logger.LogInformation("Lock acquired on record {RecordId} by user {UserId}.", recordId, userId);
                return (true, newLock);
            }
            // Lost race — loop and re-read
        }
    }

    public bool TryRelease(string recordId, string connectionId)
    {
        if (_locks.TryGetValue(recordId, out var existing) && existing.ConnectionId == connectionId)
        {
            if (_locks.TryRemove(recordId, out _))
            {
                _logger.LogInformation("Lock released on record {RecordId} by connection {ConnectionId}.", recordId, connectionId);
                return true;
            }
        }
        return false;
    }

    public LockInfo? ForceRelease(string recordId)
    {
        if (_locks.TryRemove(recordId, out var removed))
        {
            _logger.LogInformation("Lock force-released on record {RecordId}.", recordId);
            return removed;
        }
        return null;
    }

    public bool TryHeartbeat(string recordId, string connectionId)
    {
        if (!_locks.TryGetValue(recordId, out var existing))
            return false;
        if (existing.ConnectionId != connectionId)
            return false;

        var refreshed = existing with
        {
            ExpiresAtUtc = DateTime.UtcNow + TimeSpan.FromMilliseconds(_options.LockTtlMs)
        };
        _locks.TryUpdate(recordId, refreshed, existing);
        return true;
    }

    public LockInfo? GetLock(string recordId)
    {
        if (_locks.TryGetValue(recordId, out var info))
        {
            if (info.ExpiresAtUtc < DateTime.UtcNow)
            {
                _locks.TryRemove(recordId, out _);
                return null;
            }
            return info;
        }
        return null;
    }

    public IReadOnlyList<string> GetRecordsLockedByConnection(string connectionId)
    {
        return _locks.Values
            .Where(l => l.ConnectionId == connectionId)
            .Select(l => l.RecordId)
            .ToList();
    }

    public IReadOnlyList<LockInfo> ReleaseAllByConnection(string connectionId)
    {
        var released = new List<LockInfo>();
        foreach (var kv in _locks)
        {
            if (kv.Value.ConnectionId == connectionId &&
                _locks.TryRemove(kv.Key, out var removed))
            {
                released.Add(removed);
                _logger.LogInformation("Lock released on record {RecordId} due to connection {ConnectionId} disconnect.", kv.Key, connectionId);
            }
        }
        return released;
    }
}
