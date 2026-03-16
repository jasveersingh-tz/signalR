using Microsoft.AspNetCore.Mvc;
using SignalRLock.Api.Models;
using SignalRLock.Api.Services;

namespace SignalRLock.Api.Controllers;

[ApiController]
[Route("api/records")]
public class RecordsController : ControllerBase
{
    private static readonly IReadOnlyList<(string Id, string Name, string Status, DateTime UpdatedAt)> _seedRecords =
    [
        ("record-001", "Invoice #001", "Active", DateTime.UtcNow.AddMinutes(-15)),
        ("record-002", "Invoice #002", "Pending", DateTime.UtcNow.AddHours(-1)),
        ("record-003", "Customer Profile #7", "Active", DateTime.UtcNow.AddHours(-4)),
        ("record-004", "Contract #204", "Draft", DateTime.UtcNow.AddDays(-1)),
        ("record-005", "Purchase Order #88", "Approved", DateTime.UtcNow.AddDays(-2)),
        ("record-006", "Claim #441", "Pending", DateTime.UtcNow.AddMinutes(-45)),
        ("record-007", "Ticket #9012", "Open", DateTime.UtcNow.AddMinutes(-8)),
        ("record-008", "Vendor Profile #55", "Active", DateTime.UtcNow.AddDays(-3)),
        ("record-009", "Shipment #302", "In Transit", DateTime.UtcNow.AddHours(-6)),
        ("record-010", "Case #1205", "Open", DateTime.UtcNow.AddHours(-12)),
    ];

    private readonly ILockStore _lockStore;

    public RecordsController(ILockStore lockStore)
    {
        _lockStore = lockStore;
    }

    [HttpGet]
    public IActionResult GetTop([FromQuery] int limit = 10)
    {
        var boundedLimit = Math.Clamp(limit, 1, 100);

        var items = _seedRecords
            .OrderByDescending(r => r.UpdatedAt)
            .Take(boundedLimit)
            .Select(r =>
            {
                var existingLock = _lockStore.GetLock(r.Id);

                return new RecordListItem
                {
                    Id = r.Id,
                    Name = r.Name,
                    Status = r.Status,
                    UpdatedAt = r.UpdatedAt,
                    IsLocked = existingLock is not null,
                    LockedByDisplayName = existingLock?.LockedByDisplayName,
                    LockedAtUtc = existingLock?.AcquiredAtUtc,
                };
            })
            .ToArray();

        return Ok(items);
    }
}
