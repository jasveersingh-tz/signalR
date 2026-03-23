namespace SignalRLock.Api.Models;

/// <summary>
/// Represents a pending request to transfer a record lock from the current holder to a new user.
/// Stored in Redis with a short TTL (~3 minutes) so stale requests self-clean.
/// </summary>
public record LockTransferRequest
{
    public string RecordId { get; init; } = string.Empty;
    public string RequestingUserId { get; init; } = string.Empty;
    public string RequestingDisplayName { get; init; } = string.Empty;
    /// <summary>SignalR connection ID of the requesting client — used for targeted notifications.</summary>
    public string RequestingConnectionId { get; init; } = string.Empty;
    public DateTime RequestedAtUtc { get; init; }
}
