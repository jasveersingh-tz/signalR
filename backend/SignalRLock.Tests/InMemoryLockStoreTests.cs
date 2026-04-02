using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using SignalRLock.Api.Services;
using Xunit;

namespace SignalRLock.Tests;

public class InMemoryLockStoreTests
{
    private const string DefaultFeature = "default";

    private static InMemoryLockStore CreateStore(int ttlMs = 60_000, int gracePeriodMs = 5_000) =>
        new(Options.Create(new LockStoreOptions { LockTtlMs = ttlMs, GracePeriodMs = gracePeriodMs }),
            NullLogger<InMemoryLockStore>.Instance);

    // ── Acquire ───────────────────────────────────────────────────────────────

    [Fact]
    public async Task TryAcquire_FreeLock_ReturnsAcquiredTrue()
    {
        var store = CreateStore();
        var (acquired, info) = await store.TryAcquireAsync(
            DefaultFeature, "rec1", "user1", "User One", "conn1", TimeSpan.FromMilliseconds(60_000));

        Assert.True(acquired);
        Assert.NotNull(info);
        Assert.Equal("rec1", info!.RecordId);
        Assert.Equal("user1", info.LockedByUserId);
        Assert.Equal("User One", info.LockedByDisplayName);
        Assert.Equal("conn1", info.ConnectionId);
    }

    [Fact]
    public async Task TryAcquire_LockedByOther_ReturnsAcquiredFalseWithHolder()
    {
        var store = CreateStore();
        var ttl = TimeSpan.FromMilliseconds(60_000);
        await store.TryAcquireAsync(DefaultFeature, "rec1", "user1", "User One", "conn1", ttl);

        var (acquired, info) = await store.TryAcquireAsync(
            DefaultFeature, "rec1", "user2", "User Two", "conn2", ttl);

        Assert.False(acquired);
        Assert.NotNull(info);
        Assert.Equal("user1", info!.LockedByUserId);
    }

    [Fact]
    public async Task TryAcquire_SameOwner_Idempotent_ReturnsTrueAndRollsTtl()
    {
        var store = CreateStore();
        var ttl = TimeSpan.FromMilliseconds(60_000);
        await store.TryAcquireAsync(DefaultFeature, "rec1", "user1", "User One", "conn1", ttl);
        var (acquired, info) = await store.TryAcquireAsync(
            DefaultFeature, "rec1", "user1", "User One", "conn1-new", ttl);

        Assert.True(acquired);
        Assert.Equal("conn1-new", info!.ConnectionId); // connection updated on re-acquire
    }

    [Fact]
    public async Task TryAcquire_ExpiredLock_CanBeAcquiredByNewUser()
    {
        var store = CreateStore(ttlMs: 1);
        var ttl = TimeSpan.FromMilliseconds(1);
        await store.TryAcquireAsync(DefaultFeature, "rec1", "user1", "User One", "conn1", ttl);

        Thread.Sleep(5);

        var (acquired, info) = await store.TryAcquireAsync(
            DefaultFeature, "rec1", "user2", "User Two", "conn2", TimeSpan.FromMilliseconds(60_000));

        Assert.True(acquired);
        Assert.Equal("user2", info!.LockedByUserId);
    }

    // ── Release ───────────────────────────────────────────────────────────────

    [Fact]
    public async Task TryRelease_ByOwner_ReturnsTrue()
    {
        var store = CreateStore();
        var ttl = TimeSpan.FromMilliseconds(60_000);
        await store.TryAcquireAsync(DefaultFeature, "rec1", "user1", "User One", "conn1", ttl);
        Assert.True(await store.TryReleaseAsync(DefaultFeature, "rec1", "conn1"));
        Assert.Null(await store.GetLockAsync(DefaultFeature, "rec1"));
    }

    [Fact]
    public async Task TryRelease_ByNonOwner_ReturnsFalse()
    {
        var store = CreateStore();
        var ttl = TimeSpan.FromMilliseconds(60_000);
        await store.TryAcquireAsync(DefaultFeature, "rec1", "user1", "User One", "conn1", ttl);
        Assert.False(await store.TryReleaseAsync(DefaultFeature, "rec1", "conn2"));
        Assert.NotNull(await store.GetLockAsync(DefaultFeature, "rec1"));
    }

    [Fact]
    public async Task TryRelease_NonExistentLock_ReturnsFalse()
    {
        var store = CreateStore();
        Assert.False(await store.TryReleaseAsync(DefaultFeature, "rec99", "conn1"));
    }

    // ── ForceRelease ──────────────────────────────────────────────────────────

    [Fact]
    public async Task ForceRelease_LockedRecord_ReleasesAndReturnsLockInfo()
    {
        var store = CreateStore();
        var ttl = TimeSpan.FromMilliseconds(60_000);
        await store.TryAcquireAsync(DefaultFeature, "rec1", "user1", "User One", "conn1", ttl);
        var removed = await store.ForceReleaseAsync(DefaultFeature, "rec1");

        Assert.NotNull(removed);
        Assert.Equal("rec1", removed!.RecordId);
        Assert.Null(await store.GetLockAsync(DefaultFeature, "rec1"));
    }

    [Fact]
    public async Task ForceRelease_FreeLock_ReturnsNull()
    {
        var store = CreateStore();
        Assert.Null(await store.ForceReleaseAsync(DefaultFeature, "rec99"));
    }

    // ── Heartbeat ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task TryHeartbeat_ByOwner_ReturnsTrueAndRollsExpiry()
    {
        var store = CreateStore(ttlMs: 60_000);
        var ttl = TimeSpan.FromMilliseconds(60_000);
        await store.TryAcquireAsync(DefaultFeature, "rec1", "user1", "User One", "conn1", ttl);

        var before = (await store.GetLockAsync(DefaultFeature, "rec1"))!.ExpiresAtUtc;
        Thread.Sleep(5);
        Assert.True(await store.TryHeartbeatAsync(DefaultFeature, "rec1", "conn1", ttl));

        var after = (await store.GetLockAsync(DefaultFeature, "rec1"))!.ExpiresAtUtc;
        Assert.True(after >= before);
    }

    [Fact]
    public async Task TryHeartbeat_ByNonOwner_ReturnsFalse()
    {
        var store = CreateStore();
        var ttl = TimeSpan.FromMilliseconds(60_000);
        await store.TryAcquireAsync(DefaultFeature, "rec1", "user1", "User One", "conn1", ttl);
        Assert.False(await store.TryHeartbeatAsync(DefaultFeature, "rec1", "conn2", ttl));
    }

    // ── GetLock ───────────────────────────────────────────────────────────────

    [Fact]
    public async Task GetLock_ExpiredLock_ReturnsNullAndEvicts()
    {
        var store = CreateStore(ttlMs: 1);
        var ttl = TimeSpan.FromMilliseconds(1);
        await store.TryAcquireAsync(DefaultFeature, "rec1", "user1", "User One", "conn1", ttl);

        Thread.Sleep(5);

        Assert.Null(await store.GetLockAsync(DefaultFeature, "rec1"));
    }

    // ── ReleaseAllByConnection ────────────────────────────────────────────────

    [Fact]
    public async Task ReleaseAllByConnection_MultipleRecords_ReleasesAll()
    {
        var store = CreateStore();
        var ttl = TimeSpan.FromMilliseconds(60_000);
        await store.TryAcquireAsync(DefaultFeature, "rec1", "user1", "User One", "conn1", ttl);
        await store.TryAcquireAsync(DefaultFeature, "rec2", "user1", "User One", "conn1", ttl);
        await store.TryAcquireAsync(DefaultFeature, "rec3", "user2", "User Two", "conn2", ttl);

        var released = await store.ReleaseAllByConnectionAsync(DefaultFeature, "conn1");

        Assert.Equal(2, released.Count);
        Assert.Null(await store.GetLockAsync(DefaultFeature, "rec1"));
        Assert.Null(await store.GetLockAsync(DefaultFeature, "rec2"));
        Assert.NotNull(await store.GetLockAsync(DefaultFeature, "rec3")); // owned by conn2, untouched
    }

    // ── Single Lock per Record ────────────────────────────────────────────────

    [Fact]
    public async Task ConcurrentAcquire_OnlyOneLockGranted()
    {
        var store = CreateStore();
        var results = new bool[10];
        var ttl = TimeSpan.FromMilliseconds(60_000);

        await Task.WhenAll(Enumerable.Range(0, 10).Select(async i =>
        {
            var (acquired, _) = await store.TryAcquireAsync(
                DefaultFeature, "shared-rec", $"user{i}", $"User {i}", $"conn{i}", ttl);
            results[i] = acquired;
        }));

        // Exactly one thread should have acquired
        Assert.Equal(1, results.Count(r => r));
    }
}
