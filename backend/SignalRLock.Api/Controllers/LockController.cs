using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using SignalRLock.Api.Hubs;
using SignalRLock.Api.Services;

namespace SignalRLock.Api.Controllers;

/// <summary>
/// REST endpoint to bootstrap the current lock state for a record.
/// GET /api/locks/{recordId}
/// </summary>
[ApiController]
[Route("api/locks")]
public class LockController : ControllerBase
{
    private readonly ILockStore _lockStore;
    private readonly IHubContext<RecordLockHub> _hubContext;

    public LockController(ILockStore lockStore, IHubContext<RecordLockHub> hubContext)
    {
        _lockStore = lockStore;
        _hubContext = hubContext;
    }

    /// <summary>Returns the current lock for a record, or 204 if the record is not locked.</summary>
    [HttpGet("{recordId}")]
    public IActionResult GetLock(string recordId)
    {
        var info = _lockStore.GetLock(recordId);
        return info is null ? NoContent() : Ok(info);
    }

    /// <summary>
    /// Best-effort release endpoint for browser unload/refresh, where SignalR calls may not flush in time.
    /// POST /api/locks/release-on-unload
    /// </summary>
    [HttpPost("release-on-unload")]
    public async Task<IActionResult> ReleaseOnUnload([FromBody] ReleaseOnUnloadRequest request)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.RecordId) || string.IsNullOrWhiteSpace(request.UserId))
        {
            return BadRequest("recordId and userId are required.");
        }

        var released = _lockStore.TryReleaseByUser(request.RecordId, request.UserId);
        if (released)
        {
            await _hubContext.Clients.Group($"record-{request.RecordId}").SendAsync("lockReleased", request.RecordId);
        }

        return Ok(new { released });
    }

    public sealed class ReleaseOnUnloadRequest
    {
        public string RecordId { get; set; } = string.Empty;
        public string UserId { get; set; } = string.Empty;
    }
}
