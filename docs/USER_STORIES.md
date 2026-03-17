# User Stories — SignalR Record-Level Locking for AR PO Processing

---

## Epic

**EPIC-001 — Real-Time Record Locking for AR Purchase Order Processing**

| Field | Value |
|-------|-------|
| **Epic ID** | EPIC-001 |
| **Title** | Real-Time Record Locking for AR Purchase Order Processing |
| **Status** | In Progress |
| **Priority** | High |
| **Team** | Full-Stack |

### Description

As part of the Accounts Receivable (AR) Purchase Order (PO) processing workflow, multiple users may attempt to view and edit the same PO record simultaneously. Without a coordination mechanism, concurrent edits lead to data conflicts, overwritten changes, and audit inconsistencies.

This epic delivers a **real-time, record-level exclusive locking system** using **ASP.NET Core 8 + SignalR** on the backend and **Angular 21** on the frontend. When a user opens a PO record for editing, the system immediately acquires an exclusive lock. Any other user who attempts to edit the same record is blocked and shown a live banner identifying who currently holds the lock. Locks are automatically released on save, cancel, browser close, or after a configurable inactivity timeout, ensuring records never remain indefinitely locked.

### Goals

- Prevent concurrent edits to the same AR PO record.
- Provide real-time visibility of lock status across all connected users.
- Ensure no record stays permanently locked due to crashes or network drops.
- Support horizontal scaling through a Redis-backed lock store and SignalR backplane.

### Scope

| In Scope | Out of Scope |
|----------|-------------|
| Exclusive edit-lock acquisition on PO record open | Field-level or section-level locking |
| Real-time lock-status banner in the PO editor UI | Offline / PWA conflict resolution |
| Lock release on save / cancel / browser close | Full production auth (JWT — deferred to security epic) |
| Heartbeat to keep lock alive during active editing | Audit trail / lock history reporting |
| Auto-release after inactivity timeout (5 min) | Mobile / native clients |
| Grace period on network disconnect (35 s) | |
| Admin force-release of any lock | |
| Redis persistence for lock state + SignalR scale-out | |

### Acceptance Criteria

1. Only one user can hold an edit lock on a given PO record at any time.
2. All connected users see lock status updates within 1 second of acquisition or release.
3. A stale lock (from a crashed or disconnected client) is automatically released within 35 seconds.
4. The system remains functional with multiple backend instances sharing a Redis backplane.
5. End-to-end unit and integration tests cover lock acquisition, heartbeat, release, and grace-period flows.

---

## Frontend Story

**FE-001 — Implement Real-Time Lock UI for AR PO Record Editing (SignalR)**

| Field | Value |
|-------|-------|
| **Story ID** | FE-001 |
| **Epic** | EPIC-001 |
| **Title** | Implement Real-Time Lock UI for AR PO Record Editing (SignalR) |
| **Type** | Story |
| **Status** | In Progress |
| **Priority** | High |
| **Story Points** | 8 |

### User Story

> **As** an AR Processor,  
> **I want** the PO editing screen to automatically acquire an exclusive lock when I open a record,  
> **So that** I can edit the record without another user overwriting my changes at the same time.

### Background / Context

The AR PO processing module allows multiple agents to open PO records simultaneously. Without a lock, two agents could simultaneously edit the same PO, and the last save would silently overwrite the other's work. This story wires the Angular frontend to the `RecordLockHub` SignalR endpoint so that the act of clicking "Edit" on a PO record is instantly communicated to all other users via WebSocket.

### Technical Details

**Technology stack:** Angular 21, `@microsoft/signalr` client library, RxJS BehaviorSubject, Angular Signals.

#### SignalR Hub Endpoint

```
WebSocket: /hubs/recordLock
REST bootstrap: GET /api/locks/{recordId}
```

#### LockService Responsibilities

The `LockService` (Angular singleton) manages the full lifecycle of the lock for the currently open record:

| Method | Description |
|--------|-------------|
| `connect()` | Builds and starts a `HubConnection` to `/hubs/recordLock`; invokes `SubscribeToAllLocks` to join the broadcast group. |
| `acquireLock(recordId, userId, displayName)` | Invokes `AcquireLock` on the hub and starts the heartbeat timer (every 30 s). |
| `releaseLock(recordId)` | Invokes `ReleaseLock` and stops timers. Called on Save, Cancel, or `beforeunload`. |
| `heartbeat(recordId)` | Invokes `Heartbeat` every 30 s to extend the 5-minute TTL while the user is active. |

#### Server → Client Event Handling

| Event | Action in Angular |
|-------|------------------|
| `lockAcquired` | Update `lockState$` to `{ status: 'owned', lock }`. Enable edit form. Start heartbeat. |
| `lockRejected` | Update `lockState$` to `{ status: 'locked-by-other', lock }`. Keep form disabled. Show lock-holder banner. |
| `lockReleased` | Update `lockState$` to `{ status: 'unlocked' }`. Hide banner. If waiting, prompt user to retry. |
| `lockHeartbeat` | Refresh displayed TTL. |
| `error` | Log and optionally surface a toast notification. |

#### Lock Banner Component (`LockBannerComponent`)

Rendered inside the PO editor based on `lockState$`:

- **`owned`** — green banner: _"You are editing this record. Lock expires in X min."_
- **`locked-by-other`** — red banner: _"This record is currently being edited by [Display Name]. Try Again."_
- **`unlocked`** — no banner rendered.

#### Reconnect Strategy

The `HubConnectionBuilder` is configured with automatic reconnect and exponential back-off (`withAutomaticReconnect`). On reconnect, the `LockService` calls `acquireLock` again (idempotent on the server for the same user).

#### Inactivity Timer

A 5-minute client-side inactivity timer (reset on any `mousemove`, `keydown`, or `scroll` event) auto-releases the lock to prevent indefinite holding by idle users.

### Acceptance Criteria

| # | Criterion | Verification |
|---|-----------|-------------|
| AC1 | Clicking "Edit" on a PO record within 1 s broadcasts the lock to all connected clients. | Manual multi-tab test + Vitest unit test on `LockService`. |
| AC2 | A second user who clicks "Edit" on the same locked PO sees the lock-holder banner and cannot modify any field. | Manual multi-tab test. |
| AC3 | Clicking "Save" or "Cancel" releases the lock; other clients see the record as available within 1 s. | Manual multi-tab test + Vitest unit test. |
| AC4 | Closing the browser tab releases the lock via `beforeunload` best-effort call. | Manual test (observe in second tab). |
| AC5 | The heartbeat prevents the lock from expiring during an active 10-minute edit session. | Vitest timer-mocked unit test. |
| AC6 | After 5 minutes of keyboard/mouse inactivity, the lock is auto-released. | Vitest fake-timer unit test. |
| AC7 | After a network drop, the UI reconnects automatically; the lock re-asserts within the grace period. | Manual network throttle test in DevTools. |
| AC8 | All new Angular components and services have >80% Vitest code coverage. | `ng test --coverage`. |

### Tasks

- [ ] Scaffold `LockService` with `HubConnection` lifecycle management.
- [ ] Implement `acquireLock` / `releaseLock` / `heartbeat` methods.
- [ ] Subscribe to all server-sent events (`lockAcquired`, `lockRejected`, `lockReleased`, `lockHeartbeat`, `error`).
- [ ] Expose `lockState$` as an Observable / Angular Signal for components to consume.
- [ ] Build `LockBannerComponent` with conditional rendering based on `lockState$`.
- [ ] Wire `LockBannerComponent` into the PO editor template.
- [ ] Implement inactivity timer with event listeners.
- [ ] Register `beforeunload` listener to release lock on page close.
- [ ] Configure `withAutomaticReconnect` and `onreconnected` handler.
- [ ] Write Vitest unit tests for `LockService` (acquire, reject, release, heartbeat, reconnect).
- [ ] Write Vitest unit tests for `LockBannerComponent` (all three states).

### Dependencies

- **FE-001** depends on **BE-001** (hub endpoint and Redis store must be deployed).
- `@microsoft/signalr` npm package must be installed.
- CORS and WebSocket proxy config (`proxy.conf.json`) must route `/hubs/*` to the backend.

---

## Backend Story

**BE-001 — Implement Redis-Backed Lock Store and SignalR Hub for AR PO Record Locking**

| Field | Value |
|-------|-------|
| **Story ID** | BE-001 |
| **Epic** | EPIC-001 |
| **Title** | Implement Redis-Backed Lock Store and SignalR Hub for AR PO Record Locking |
| **Type** | Story |
| **Status** | In Progress |
| **Priority** | High |
| **Story Points** | 8 |

### User Story

> **As** a backend engineer,  
> **I want** the ASP.NET Core API to manage exclusive PO record locks in Redis via a SignalR hub,  
> **So that** the system scales horizontally and locks survive individual server-instance restarts.

### Background / Context

The initial POC used an in-memory `ConcurrentDictionary` for lock storage, which breaks in a load-balanced or auto-scaled deployment because each instance holds its own independent lock table. This story replaces the in-memory store with `RedisLockStore`, which uses `StackExchange.Redis` to persist lock state in Redis with atomic operations and TTL-based expiration. A Redis SignalR backplane is added so hub messages are fanned out across all backend instances.

### Technical Details

**Technology stack:** ASP.NET Core 8, `Microsoft.AspNetCore.SignalR`, `StackExchange.Redis`, `Microsoft.AspNetCore.SignalR.StackExchangeRedis`, xUnit, Moq.

#### Hub Endpoint

```
WebSocket: /hubs/recordLock
```

#### Hub Method Contract

**Client → Server Invocations**

| Method | Parameters | Description |
|--------|------------|-------------|
| `SubscribeToAllLocks` | — | Adds caller to the `all-locks` broadcast group. |
| `AcquireLock` | `recordId`, `userId`, `displayName` | Atomically acquires the lock. Broadcasts `lockAcquired` or sends `lockRejected` to caller. |
| `ReleaseLock` | `recordId` | Releases the caller's lock. Broadcasts `lockReleased`. |
| `Heartbeat` | `recordId` | Extends TTL. Sends `lockHeartbeat` to caller. |
| `ForceRelease` | `recordId` | Admin: removes any lock regardless of owner. Broadcasts `lockReleased`. |

**Server → Client Events**

| Event | Recipient | Payload |
|-------|-----------|---------|
| `lockAcquired` | Group `all-locks` | `(recordId, LockInfo)` |
| `lockRejected` | Caller only | `(recordId, LockInfo)` |
| `lockReleased` | Group `all-locks` | `(recordId)` |
| `lockHeartbeat` | Caller only | `(recordId, LockInfo)` |
| `error` | Caller only | `(message)` |

#### Redis Data Structures

| Key | Type | TTL | Purpose |
|-----|------|-----|---------|
| `lock:{recordId}` | String (JSON) | 5 min | Serialised `LockInfo`; atomic acquisition via check-and-set. |
| `connection-locks:{connectionId}` | Set | No TTL | Tracks which records a connection holds; used for bulk release on disconnect. |

#### ILockStore Interface

```csharp
(bool Acquired, LockInfo? Lock) TryAcquire(string recordId, string userId, string displayName, string connectionId);
bool    TryRelease(string recordId, string connectionId);
LockInfo? ForceRelease(string recordId);
bool    TryHeartbeat(string recordId, string connectionId);
LockInfo? GetLock(string recordId);
IReadOnlyList<string>   GetRecordsLockedByConnection(string connectionId);
IReadOnlyList<LockInfo> ReleaseAllByConnection(string connectionId);
IReadOnlyList<LockInfo> GetAllLocks();
```

#### Redis Lock Acquisition Flow

1. `GET lock:{recordId}` — check for existing lock.
2. If **absent** → `SET lock:{recordId} <JSON> EX 300` + `SADD connection-locks:{connId} {recordId}` → return `(true, newLock)`.
3. If **present, same userId** → update `ConnectionId` and `ExpiresAtUtc`, `SET ... EX 300` (refresh) → return `(true, refreshedLock)`.
4. If **present, different userId** → return `(false, existingLock)`.

#### Disconnect & Grace Period

On `OnDisconnectedAsync`, a 35-second `CancellationTokenSource` timer is started. If the client reconnects and re-acquires the lock before expiry, the timer is cancelled. If the grace period elapses, `ReleaseAllByConnection` is called and `lockReleased` is broadcast for each freed record via `IHubContext<RecordLockHub>`.

#### Configuration (`appsettings.json`)

```json
{
  "Redis": {
    "ConnectionString": "localhost:6379"
  },
  "LockStore": {
    "LockTtlMs": 300000,
    "GracePeriodMs": 35000,
    "HeartbeatIntervalMs": 30000
  }
}
```

#### Scale-out — SignalR Redis Backplane

```csharp
builder.Services.AddSignalR()
    .AddStackExchangeRedis(redisConnectionString);
```

This ensures hub messages (e.g., `lockAcquired`) emitted by one server instance are delivered to clients connected to any other instance.

### REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/locks` | GET | Returns all currently active locks (bootstrap for list view). |
| `/api/locks/{recordId}` | GET | Returns lock for a specific record, or 204 if unlocked (bootstrap for editor). |

### Acceptance Criteria

| # | Criterion | Verification |
|---|-----------|-------------|
| AC1 | `TryAcquire` is atomic: two simultaneous requests for the same record grant the lock to exactly one caller. | xUnit test with parallel tasks against a test Redis instance. |
| AC2 | `TryAcquire` with the same `userId` on an already-held lock refreshes TTL and returns success (idempotent). | xUnit unit test. |
| AC3 | `TryRelease` only succeeds for the connection that holds the lock; returns false otherwise. | xUnit unit test. |
| AC4 | `TryHeartbeat` extends the Redis TTL for the lock key. | xUnit unit test verifying TTL after heartbeat. |
| AC5 | On disconnect, if no reconnect occurs within 35 s, all locks held by that connection are released and `lockReleased` is broadcast. | xUnit integration test with fake timer. |
| AC6 | On reconnect within 35 s, grace timer is cancelled and the lock is idempotently re-acquired. | xUnit integration test. |
| AC7 | `GET /api/locks` and `GET /api/locks/{recordId}` return correct lock state. | xUnit integration test against test Redis. |
| AC8 | With two backend instances sharing a Redis backplane, a `lockAcquired` event sent from Instance A is received by a client connected to Instance B. | Manual test with two `dotnet run` processes. |
| AC9 | All `ILockStore` methods have xUnit tests with >90% line coverage. | `dotnet test --collect:"XPlat Code Coverage"`. |

### Tasks

- [ ] Register `StackExchange.Redis` `IConnectionMultiplexer` in DI (`Program.cs`).
- [ ] Implement `RedisLockStore : ILockStore` with `TryAcquire`, `TryRelease`, `ForceRelease`, `TryHeartbeat`, `GetLock`, `GetRecordsLockedByConnection`, `ReleaseAllByConnection`, `GetAllLocks`.
- [ ] Register `RedisLockStore` as the `ILockStore` implementation in DI.
- [ ] Add `RecordLockHub` with all five hub methods and `OnDisconnectedAsync` grace timer.
- [ ] Add `LockController` with `GET /api/locks` and `GET /api/locks/{recordId}`.
- [ ] Add Redis SignalR backplane via `AddStackExchangeRedis`.
- [ ] Expose `LockStoreOptions` configuration class and bind from `appsettings.json`.
- [ ] Write xUnit unit tests for all `RedisLockStore` methods (mocked Redis via `FakeItEasy` / `Moq`).
- [ ] Write xUnit integration tests for hub flows using `TestServer` and a real (or `Testcontainers`) Redis instance.
- [ ] Update `appsettings.json` with Redis connection string and lock store defaults.
- [ ] Update `README.md` and `ARCHITECTURE.md` to document the Redis setup.

### Dependencies

- Redis 7.x must be available (Docker: `docker run -p 6379:6379 redis:7`).
- `StackExchange.Redis` NuGet package.
- `Microsoft.AspNetCore.SignalR.StackExchangeRedis` NuGet package.
- **BE-001** is a prerequisite for **FE-001**.

---

## Story Relationship Map

```
EPIC-001 — Real-Time Record Locking for AR PO Processing
├── BE-001 — Redis-Backed Lock Store + SignalR Hub  (Backend)
└── FE-001 — Real-Time Lock UI via SignalR           (Frontend, depends on BE-001)
```

---

## Exporting to DOCX

To convert this document to a Word file, run:

```bash
# Install pandoc if not already installed
# macOS:   brew install pandoc
# Ubuntu:  sudo apt-get install pandoc

pandoc docs/USER_STORIES.md -o docs/USER_STORIES.docx \
  --from markdown \
  --to docx \
  --toc \
  --toc-depth=2
```

A pre-built `USER_STORIES.docx` is generated in the `docs/` folder as part of the CI pipeline (see `.github/workflows/docs.yml` if configured).
