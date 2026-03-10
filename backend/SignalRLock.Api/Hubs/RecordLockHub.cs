using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using SignalRLock.Api.Models;
using SignalRLock.Api.Services;

namespace SignalRLock.Api.Hubs;

/// <summary>
/// SignalR hub for record-level locking.
/// Endpoint: /hubs/recordLock
/// </summary>
public class RecordLockHub : Hub
{
    // Grace period: connectionId → cancellation token source + locked records
    private static readonly ConcurrentDictionary<string, GraceEntry> _graceTimers =
        new(StringComparer.Ordinal);

    private readonly ILockStore _lockStore;
    private readonly LockStoreOptions _options;
    private readonly ILogger<RecordLockHub> _logger;

    public RecordLockHub(ILockStore lockStore, IOptions<LockStoreOptions> options, ILogger<RecordLockHub> logger)
    {
        _lockStore = lockStore;
        _options = options.Value;
        _logger = logger;
    }

    // ─── Client → Server ──────────────────────────────────────────────────────

    /// <summary>Acquire a lock on a record.  Broadcasts lockAcquired or sends lockRejected.</summary>
    public async Task AcquireLock(string recordId, string userId, string displayName)
    {
        if (string.IsNullOrWhiteSpace(recordId) || string.IsNullOrWhiteSpace(userId))
        {
            await Clients.Caller.SendAsync("error", "recordId and userId are required.");
            return;
        }

        var (acquired, lockInfo) = _lockStore.TryAcquire(recordId, userId, displayName, Context.ConnectionId);

        // Always join the record group so this connection receives broadcasts
        await Groups.AddToGroupAsync(Context.ConnectionId, RecordGroup(recordId));

        if (acquired)
        {
            _logger.LogInformation("AcquireLock: record={RecordId} user={UserId} conn={Conn}", recordId, userId, Context.ConnectionId);
            await Clients.Group(RecordGroup(recordId)).SendAsync("lockAcquired", recordId, lockInfo);
        }
        else
        {
            await Clients.Caller.SendAsync("lockRejected", recordId, lockInfo);
        }
    }

    /// <summary>Release the caller's lock on a record.</summary>
    public async Task ReleaseLock(string recordId)
    {
        if (string.IsNullOrWhiteSpace(recordId))
        {
            await Clients.Caller.SendAsync("error", "recordId is required.");
            return;
        }

        var released = _lockStore.TryRelease(recordId, Context.ConnectionId);
        if (released)
        {
            _logger.LogInformation("ReleaseLock: record={RecordId} conn={Conn}", recordId, Context.ConnectionId);
            await Clients.Group(RecordGroup(recordId)).SendAsync("lockReleased", recordId);
        }

        await Groups.RemoveFromGroupAsync(Context.ConnectionId, RecordGroup(recordId));
    }

    /// <summary>Heartbeat to roll the TTL forward.</summary>
    public async Task Heartbeat(string recordId)
    {
        if (string.IsNullOrWhiteSpace(recordId))
            return;

        var ok = _lockStore.TryHeartbeat(recordId, Context.ConnectionId);
        if (ok)
        {
            var info = _lockStore.GetLock(recordId);
            await Clients.Caller.SendAsync("lockHeartbeat", recordId, info);
        }
    }

    /// <summary>Admin: force-release any lock on a record.</summary>
    public async Task ForceRelease(string recordId)
    {
        // POC: accept any caller; production should verify admin role.
        if (string.IsNullOrWhiteSpace(recordId))
        {
            await Clients.Caller.SendAsync("error", "recordId is required.");
            return;
        }

        var removed = _lockStore.ForceRelease(recordId);
        if (removed != null)
        {
            _logger.LogWarning("ForceRelease: record={RecordId} by admin conn={Conn}", recordId, Context.ConnectionId);
            await Clients.Group(RecordGroup(recordId)).SendAsync("lockReleased", recordId);
        }
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    public override Task OnConnectedAsync()
    {
        // Cancel any pending grace timer for this connection (reconnect scenario)
        if (_graceTimers.TryRemove(Context.ConnectionId, out var entry))
        {
            entry.Cts.Cancel();
            entry.Cts.Dispose();
        }
        _logger.LogInformation("Connected: {ConnectionId}", Context.ConnectionId);
        return base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var connectionId = Context.ConnectionId;
        var gracePeriod = TimeSpan.FromMilliseconds(_options.GracePeriodMs);

        var lockedRecords = _lockStore.GetRecordsLockedByConnection(connectionId);
        if (lockedRecords.Count == 0)
        {
            _logger.LogInformation("Disconnected (no locks): {ConnectionId}", connectionId);
            await base.OnDisconnectedAsync(exception);
            return;
        }

        _logger.LogInformation("Disconnected: {ConnectionId}; starting grace period of {Grace}ms for records [{Records}].",
            connectionId, _options.GracePeriodMs, string.Join(", ", lockedRecords));

        var cts = new CancellationTokenSource();
        var entry = new GraceEntry(cts, lockedRecords);
        _graceTimers[connectionId] = entry;

        // Fire-and-forget grace timer using the hub context factory via DI.
        // We capture the IHubContext through a scoped closure to broadcast after grace.
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(gracePeriod, cts.Token);

                // Grace period elapsed without reconnect → release all locks
                var released = _lockStore.ReleaseAllByConnection(connectionId);

                // We need an IHubContext to send messages outside the hub instance.
                // It's injected via the lambda closure captured from the DI container below.
                if (released.Count > 0)
                {
                    await BroadcastReleasesAsync(connectionId, released);
                }
            }
            catch (TaskCanceledException)
            {
                _logger.LogInformation("Grace period cancelled for {ConnectionId} (reconnected).", connectionId);
            }
            finally
            {
                _graceTimers.TryRemove(connectionId, out _);
            }
        }, CancellationToken.None);

        await base.OnDisconnectedAsync(exception);
    }

    // Populated by the hub infrastructure via IHubContext injection below
    internal static IHubContext<RecordLockHub>? HubContext { get; set; }

    private async Task BroadcastReleasesAsync(string connectionId, IReadOnlyList<LockInfo> released)
    {
        var ctx = HubContext;
        if (ctx == null)
        {
            _logger.LogWarning("HubContext not available; cannot broadcast releases for {ConnectionId}.", connectionId);
            return;
        }

        foreach (var lockInfo in released)
        {
            _logger.LogInformation("Broadcasting lockReleased for record {RecordId} after grace expiry.", lockInfo.RecordId);
            await ctx.Clients.Group(RecordGroup(lockInfo.RecordId)).SendAsync("lockReleased", lockInfo.RecordId);
        }
    }

    private static string RecordGroup(string recordId) => $"record-{recordId}";

    private record GraceEntry(CancellationTokenSource Cts, IReadOnlyList<string> LockedRecords);
}
