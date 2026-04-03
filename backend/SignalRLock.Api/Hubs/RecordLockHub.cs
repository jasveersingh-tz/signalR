using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using SignalRLock.Api.Models;
using SignalRLock.Api.Services;

namespace SignalRLock.Api.Hubs;

/// <summary>
/// Single SignalR hub that serves all features.
/// The client passes its feature identity once as a query-string parameter on connect:
///   /hubs/locks?feature=purchase-orders
///
/// The featureKey is stored in Context.Items for the lifetime of the connection and used to:
///   - namespace Redis keys (via ILockStore)
///   - scope SignalR broadcast groups so each feature only receives its own lock events
///   - resolve per-feature timings from LockFeaturesConfig
/// </summary>
public class RecordLockHub : Hub
{
    private static readonly ConcurrentDictionary<string, GraceEntry> _graceTimers =
        new(StringComparer.Ordinal);

    private readonly ILockStore _lockStore;
    private readonly LockFeaturesConfig _config;
    private readonly ILogger<RecordLockHub> _logger;

    public RecordLockHub(
        ILockStore lockStore,
        IOptions<LockFeaturesConfig> config,
        ILogger<RecordLockHub> logger)
    {
        _lockStore = lockStore;
        _config = config.Value;
        _logger = logger;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    public override Task OnConnectedAsync()
    {
        var featureKey = Context.GetHttpContext()?.Request.Query["feature"].ToString();
        if (string.IsNullOrWhiteSpace(featureKey))
            featureKey = DefaultFeatureKey;

        Context.Items[FeatureKeyItem] = featureKey;

        if (_graceTimers.TryRemove(Context.ConnectionId, out var entry))
        {
            entry.Cts.Cancel();
            entry.Cts.Dispose();
        }

        _logger.LogInformation("Connected: {ConnectionId} feature={Feature}", Context.ConnectionId, featureKey);
        return base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var connectionId = Context.ConnectionId;
        var featureKey = GetFeatureKey();
        var gracePeriod = TimeSpan.FromMilliseconds(_config.GetOptionsFor(featureKey).GracePeriodMs);

        var lockedRecords = await _lockStore.GetRecordsLockedByConnectionAsync(featureKey, connectionId);
        if (lockedRecords.Count == 0)
        {
            _logger.LogInformation("Disconnected (no locks): {ConnectionId} feature={Feature}", connectionId, featureKey);
            await base.OnDisconnectedAsync(exception);
            return;
        }

        _logger.LogInformation(
            "Disconnected: {ConnectionId} feature={Feature}; grace period {Grace}ms for [{Records}].",
            connectionId, featureKey, gracePeriod.TotalMilliseconds, string.Join(", ", lockedRecords));

        var cts = new CancellationTokenSource();
        _graceTimers[connectionId] = new GraceEntry(cts, lockedRecords, featureKey);

        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(gracePeriod, cts.Token);
                var released = await _lockStore.ReleaseAllByConnectionAsync(featureKey, connectionId);
                if (released.Count > 0)
                    await BroadcastReleasesAsync(connectionId, featureKey, released);
            }
            catch (TaskCanceledException)
            {
                _logger.LogInformation("Grace period cancelled for {ConnectionId} (reconnected).", connectionId);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex,
                    "Grace-period cleanup failed for {ConnectionId}; locks may remain until TTL expiry.",
                    connectionId);
            }
            finally
            {
                _graceTimers.TryRemove(connectionId, out _);
            }
        }, CancellationToken.None);

        await base.OnDisconnectedAsync(exception);
    }

    // ── Client → Server ───────────────────────────────────────────────────────

    /// <summary>Subscribe to lock change events for all records in this feature.</summary>
    public async Task SubscribeToAllLocks()
    {
        try
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, GetAllLocksGroup(GetFeatureKey()));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "SubscribeToAllLocks failed for connection {ConnectionId}", Context.ConnectionId);
            await Clients.Caller.SendAsync("error", "Failed to subscribe to lock events. Please try again.");
        }
    }

    /// <summary>Acquire a lock on a record. Broadcasts lockAcquired or sends lockRejected.</summary>
    public async Task AcquireLock(string recordId, string userId, string displayName)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(recordId) || string.IsNullOrWhiteSpace(userId))
            {
                await Clients.Caller.SendAsync("error", "recordId and userId are required.");
                return;
            }

            var featureKey = GetFeatureKey();
            var lockTtl = TimeSpan.FromMilliseconds(_config.GetOptionsFor(featureKey).LockTtlMs);
            var (acquired, lockInfo) = await _lockStore.TryAcquireAsync(
                featureKey, recordId, userId, displayName, Context.ConnectionId, lockTtl);

            if (acquired)
            {
                _logger.LogInformation(
                    "AcquireLock: feature={Feature} record={RecordId} user={UserId} conn={Conn}",
                    featureKey, recordId, userId, Context.ConnectionId);
                await Clients.Group(GetAllLocksGroup(featureKey)).SendAsync("lockAcquired", recordId, lockInfo);
            }
            else
            {
                await Clients.Caller.SendAsync("lockRejected", recordId, lockInfo);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "AcquireLock failed for record {RecordId}", recordId);
            await Clients.Caller.SendAsync("error", "Failed to acquire lock. Please try again.");
        }
    }

    /// <summary>Release the caller's lock on a record.</summary>
    public async Task ReleaseLock(string recordId)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(recordId))
            {
                await Clients.Caller.SendAsync("error", "recordId is required.");
                return;
            }

            var featureKey = GetFeatureKey();
            var released = await _lockStore.TryReleaseAsync(featureKey, recordId, Context.ConnectionId);
            if (released)
            {
                _logger.LogInformation(
                    "ReleaseLock: feature={Feature} record={RecordId} conn={Conn}",
                    featureKey, recordId, Context.ConnectionId);
                await Clients.Group(GetAllLocksGroup(featureKey)).SendAsync("lockReleased", recordId);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ReleaseLock failed for record {RecordId}", recordId);
            await Clients.Caller.SendAsync("error", "Failed to release lock. Please try again.");
        }
    }

    /// <summary>Heartbeat — rolls the TTL forward for an owned lock.</summary>
    public async Task Heartbeat(string recordId)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(recordId)) return;

            var featureKey = GetFeatureKey();
            var lockTtl = TimeSpan.FromMilliseconds(_config.GetOptionsFor(featureKey).LockTtlMs);
            var ok = await _lockStore.TryHeartbeatAsync(featureKey, recordId, Context.ConnectionId, lockTtl);
            if (ok)
            {
                var info = await _lockStore.GetLockAsync(featureKey, recordId);
                await Clients.Caller.SendAsync("lockHeartbeat", recordId, info);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Heartbeat failed for record {RecordId}", recordId);
            await Clients.Caller.SendAsync("error", "Failed to send heartbeat. Please try again.");
        }
    }

    /// <summary>Admin: force-release any lock on a record.</summary>
    public async Task ForceRelease(string recordId)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(recordId))
            {
                await Clients.Caller.SendAsync("error", "recordId is required.");
                return;
            }

            var featureKey = GetFeatureKey();
            var removed = await _lockStore.ForceReleaseAsync(featureKey, recordId);
            if (removed != null)
            {
                _logger.LogWarning(
                    "ForceRelease: feature={Feature} record={RecordId} by conn={Conn}",
                    featureKey, recordId, Context.ConnectionId);
                await Clients.Group(GetAllLocksGroup(featureKey)).SendAsync("lockReleased", recordId);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ForceRelease failed for record {RecordId}", recordId);
            await Clients.Caller.SendAsync("error", "Failed to force release lock. Please try again.");
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    internal static IHubContext<RecordLockHub>? HubContext { get; set; }

    private const string FeatureKeyItem = "featureKey";
    private const string DefaultFeatureKey = "default";

    private string GetFeatureKey() =>
        Context.Items.TryGetValue(FeatureKeyItem, out var v) && v is string s ? s : DefaultFeatureKey;

    private static string GetAllLocksGroup(string featureKey) => $"all-locks:{featureKey}";

    private async Task BroadcastReleasesAsync(
        string connectionId, string featureKey, IReadOnlyList<LockInfo> released)
    {
        var ctx = HubContext;
        if (ctx == null)
        {
            _logger.LogWarning("HubContext unavailable; cannot broadcast releases for {ConnectionId}.", connectionId);
            return;
        }

        var group = GetAllLocksGroup(featureKey);
        foreach (var lockInfo in released)
        {
            _logger.LogInformation(
                "Broadcasting lockReleased after grace expiry: feature={Feature} record={RecordId}",
                featureKey, lockInfo.RecordId);
            await ctx.Clients.Group(group).SendAsync("lockReleased", lockInfo.RecordId);
        }
    }

    private record GraceEntry(CancellationTokenSource Cts, IReadOnlyList<string> LockedRecords, string FeatureKey);
}
