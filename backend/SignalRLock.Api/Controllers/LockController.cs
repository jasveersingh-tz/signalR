using Microsoft.AspNetCore.Mvc;
using SignalRLock.Api.Services;

namespace SignalRLock.Api.Controllers;

/// <summary>
/// REST endpoint to bootstrap lock state before the SignalR connection is established.
/// The ?feature= query param must match the featureKey the client passes to the hub.
/// </summary>
[ApiController]
[Route("api/locks")]
public class LockController : ControllerBase
{
    private readonly ILockStore _lockStore;

    public LockController(ILockStore lockStore) => _lockStore = lockStore;

    /// <summary>Returns all currently active locks for a feature.</summary>
    [HttpGet]
    public IActionResult GetAllLocks([FromQuery] string feature = "default") =>
        Ok(_lockStore.GetAllLocks(feature));

    /// <summary>Returns the current lock for a record, or 204 if not locked.</summary>
    [HttpGet("{recordId}")]
    public IActionResult GetLock(string recordId, [FromQuery] string feature = "default")
    {
        var info = _lockStore.GetLock(feature, recordId);
        return info is null ? NoContent() : Ok(info);
    }
}
