namespace SignalRLock.Api.Models;

public sealed class RecordListItem
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string Status { get; init; }
    public required DateTime UpdatedAt { get; init; }
    public bool IsLocked { get; init; }
    public string? LockedByDisplayName { get; init; }
    public DateTime? LockedAtUtc { get; init; }
}
