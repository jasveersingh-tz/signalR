using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using SignalRLock.Api.Services;
using Xunit;

namespace SignalRLock.Tests;

public class InMemoryLockStoreTests
{
    private static InMemoryLockStore CreateStore(int ttlMs = 60_000, int gracePeriodMs = 5_000) =>
        new(Options.Create(new LockStoreOptions { LockTtlMs = ttlMs, GracePeriodMs = gracePeriodMs }),
            NullLogger<InMemoryLockStore>.Instance);

    // ── Acquire ───────────────────────────────────────────────────────────────

    [Fact]
    public void TryAcquire_FreeLock_ReturnsAcquiredTrue()
    {
        var store = CreateStore();
        var (acquired, info) = store.TryAcquire("rec1", "user1", "User One", "conn1");

        Assert.True(acquired);
        Assert.NotNull(info);
        Assert.Equal("rec1", info!.RecordId);
        Assert.Equal("user1", info.LockedByUserId);
        Assert.Equal("User One", info.LockedByDisplayName);
        Assert.Equal("conn1", info.ConnectionId);
    }

    [Fact]
    public void TryAcquire_LockedByOther_ReturnsAcquiredFalseWithHolder()
    {
        var store = CreateStore();
        store.TryAcquire("rec1", "user1", "User One", "conn1");

        var (acquired, info) = store.TryAcquire("rec1", "user2", "User Two", "conn2");

        Assert.False(acquired);
        Assert.NotNull(info);
        Assert.Equal("user1", info!.LockedByUserId);
    }

    [Fact]
    public void TryAcquire_SameOwner_Idempotent_ReturnsTrueAndRollsTtl()
    {
        var store = CreateStore();
        store.TryAcquire("rec1", "user1", "User One", "conn1");
        var (acquired, info) = store.TryAcquire("rec1", "user1", "User One", "conn1-new");

        Assert.True(acquired);
        Assert.Equal("conn1-new", info!.ConnectionId); // connection updated on re-acquire
    }

    [Fact]
    public void TryAcquire_ExpiredLock_CanBeAcquiredByNewUser()
    {
        var store = CreateStore(ttlMs: 1); // 1 ms TTL – immediately expired
        store.TryAcquire("rec1", "user1", "User One", "conn1");

        Thread.Sleep(5);

        var (acquired, info) = store.TryAcquire("rec1", "user2", "User Two", "conn2");

        Assert.True(acquired);
        Assert.Equal("user2", info!.LockedByUserId);
    }

    // ── Release ───────────────────────────────────────────────────────────────

    [Fact]
    public void TryRelease_ByOwner_ReturnsTrue()
    {
        var store = CreateStore();
        store.TryAcquire("rec1", "user1", "User One", "conn1");
        Assert.True(store.TryRelease("rec1", "conn1"));
        Assert.Null(store.GetLock("rec1"));
    }

    [Fact]
    public void TryRelease_ByNonOwner_ReturnsFalse()
    {
        var store = CreateStore();
        store.TryAcquire("rec1", "user1", "User One", "conn1");
        Assert.False(store.TryRelease("rec1", "conn2"));
        Assert.NotNull(store.GetLock("rec1"));
    }

    [Fact]
    public void TryRelease_NonExistentLock_ReturnsFalse()
    {
        var store = CreateStore();
        Assert.False(store.TryRelease("rec99", "conn1"));
    }

    // ── ForceRelease ──────────────────────────────────────────────────────────

    [Fact]
    public void ForceRelease_LockedRecord_ReleasesAndReturnsLockInfo()
    {
        var store = CreateStore();
        store.TryAcquire("rec1", "user1", "User One", "conn1");
        var removed = store.ForceRelease("rec1");

        Assert.NotNull(removed);
        Assert.Equal("rec1", removed!.RecordId);
        Assert.Null(store.GetLock("rec1"));
    }

    [Fact]
    public void ForceRelease_FreeLock_ReturnsNull()
    {
        var store = CreateStore();
        Assert.Null(store.ForceRelease("rec99"));
    }

    // ── Heartbeat ─────────────────────────────────────────────────────────────

    [Fact]
    public void TryHeartbeat_ByOwner_ReturnsTrueAndRollsExpiry()
    {
        var store = CreateStore(ttlMs: 60_000);
        store.TryAcquire("rec1", "user1", "User One", "conn1");

        var before = store.GetLock("rec1")!.ExpiresAtUtc;
        Thread.Sleep(5);
        Assert.True(store.TryHeartbeat("rec1", "conn1"));

        var after = store.GetLock("rec1")!.ExpiresAtUtc;
        Assert.True(after >= before);
    }

    [Fact]
    public void TryHeartbeat_ByNonOwner_ReturnsFalse()
    {
        var store = CreateStore();
        store.TryAcquire("rec1", "user1", "User One", "conn1");
        Assert.False(store.TryHeartbeat("rec1", "conn2"));
    }

    // ── GetLock ───────────────────────────────────────────────────────────────

    [Fact]
    public void GetLock_ExpiredLock_ReturnsNullAndEvicts()
    {
        var store = CreateStore(ttlMs: 1);
        store.TryAcquire("rec1", "user1", "User One", "conn1");

        Thread.Sleep(5);

        Assert.Null(store.GetLock("rec1"));
    }

    // ── ReleaseAllByConnection ────────────────────────────────────────────────

    [Fact]
    public void ReleaseAllByConnection_MultipleRecords_ReleasesAll()
    {
        var store = CreateStore();
        store.TryAcquire("rec1", "user1", "User One", "conn1");
        store.TryAcquire("rec2", "user1", "User One", "conn1");
        store.TryAcquire("rec3", "user2", "User Two", "conn2");

        var released = store.ReleaseAllByConnection("conn1");

        Assert.Equal(2, released.Count);
        Assert.Null(store.GetLock("rec1"));
        Assert.Null(store.GetLock("rec2"));
        Assert.NotNull(store.GetLock("rec3")); // owned by conn2, untouched
    }

    // ── Single Lock per Record ────────────────────────────────────────────────

    [Fact]
    public void ConcurrentAcquire_OnlyOneLockGranted()
    {
        var store = CreateStore();
        var results = new bool[10];

        Parallel.For(0, 10, i =>
        {
            var (acquired, _) = store.TryAcquire("shared-rec", $"user{i}", $"User {i}", $"conn{i}");
            results[i] = acquired;
        });

        // Exactly one thread should have acquired
        Assert.Equal(1, results.Count(r => r));
    }
}
