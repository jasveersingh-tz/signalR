namespace SignalRLock.Api.Models;

public record LockInfo
{
    public string RecordId { get; init; } = string.Empty;
    public string LockedByUserId { get; init; } = string.Empty;
    public string LockedByDisplayName { get; init; } = string.Empty;
    public DateTime AcquiredAtUtc { get; init; }
    public DateTime ExpiresAtUtc { get; init; }
    /// <summary>The SignalR connection ID that holds the lock.</summary>
    public string ConnectionId { get; init; } = string.Empty;
}
