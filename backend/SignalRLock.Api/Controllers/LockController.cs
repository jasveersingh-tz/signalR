using Microsoft.AspNetCore.Mvc;
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

    public LockController(ILockStore lockStore) => _lockStore = lockStore;

    /// <summary>Returns the current lock for a record, or 204 if the record is not locked.</summary>
    [HttpGet("{recordId}")]
    public IActionResult GetLock(string recordId)
    {
        var info = _lockStore.GetLock(recordId);
        return info is null ? NoContent() : Ok(info);
    }
}
