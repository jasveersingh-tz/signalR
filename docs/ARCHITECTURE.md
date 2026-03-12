# Architecture & Functionality Flow

> **SignalR Record-Level Locking POC**  
> A real-time, record-level exclusive editing lock system using ASP.NET Core SignalR and Angular.

---

## Table of Contents

1. [High-Level Architecture](#1-high-level-architecture)
2. [Technology Stack](#2-technology-stack)
3. [Component Overview](#3-component-overview)
4. [Data Models](#4-data-models)
5. [SignalR Hub Contract](#5-signalr-hub-contract)
6. [Functional Flows](#6-functional-flows)
   - [Application Startup](#61-application-startup)
   - [Lock Acquisition](#62-lock-acquisition)
   - [Active Editing (Heartbeat)](#63-active-editing-heartbeat)
   - [Lock Release](#64-lock-release)
   - [Multi-User Conflict](#65-multi-user-conflict)
   - [Disconnect & Grace Period](#66-disconnect--grace-period)
7. [Redis Data Structures](#7-redis-data-structures)
8. [Key Design Patterns](#8-key-design-patterns)
9. [Configuration Reference](#9-configuration-reference)

---

## 1. High-Level Architecture

The system consists of three layers: an **Angular frontend**, an **ASP.NET Core backend** (hosting both a REST controller and a SignalR hub), and a **Redis** store that persists lock state across server instances.

```mermaid
graph TB
    subgraph Browser["Browser (Angular 21)"]
        UI["RecordEditor\nComponent"]
        Banner["LockBanner\nComponent"]
        LS["LockService\n(@microsoft/signalr client)"]
        Auth["MockAuth\n(localStorage)"]
        UI --> LS
        UI --> Banner
        LS --> Auth
    end

    subgraph Backend["Backend (ASP.NET Core 8)"]
        REST["LockController\nGET /api/locks/{recordId}"]
        Hub["RecordLockHub\n/hubs/recordLock"]
        Store["ILockStore"]
        REST --> Store
        Hub --> Store
    end

    subgraph Storage["Storage"]
        Redis[(Redis\nlocalhost:6379)]
        Store --> Redis
    end

    LS -- "HTTP REST (bootstrap)" --> REST
    LS -- "WebSocket (SignalR)" --> Hub
```

**Communication Protocols:**

| Channel | Protocol | Purpose |
|---------|----------|---------|
| `GET /api/locks/{recordId}` | HTTP/REST | Bootstrap lock state on page load |
| `/hubs/recordLock` | WebSocket (SignalR) | Real-time lock events (acquire, release, heartbeat) |

---

## 2. Technology Stack

### Backend

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | ASP.NET Core | 8.0 LTS |
| Real-time | ASP.NET Core SignalR | Built-in |
| Cache / Lock Store | Redis (StackExchange.Redis) | 2.11.8 |
| Testing | xUnit | 2.5.3 |
| Test Host | Microsoft.AspNetCore.Mvc.Testing | 8.0.0 |
| Language | C# (nullable reference types) | Latest |

### Frontend

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | Angular | 21.2.0 |
| SignalR Client | @microsoft/signalr | 10.0.0 |
| Reactive | RxJS | 7.8.0 |
| Testing | Vitest | 4.0.8 |
| Linting | ESLint | 10.0.2 |
| Formatting | Prettier | 3.8.1 |
| Language | TypeScript | 5.9.2 |

---

## 3. Component Overview

### Backend Components

```mermaid
classDiagram
    class Program {
        +ConfigureServices()
        +MapEndpoints()
    }

    class LockController {
        -ILockStore _lockStore
        +GetLock(recordId) IActionResult
    }

    class RecordLockHub {
        -ILockStore _lockStore
        -IHubContext~RecordLockHub~ _hubContext
        -Dictionary~string,CTS~ _graceTimers
        +AcquireLock(recordId, userId, displayName)
        +ReleaseLock(recordId)
        +Heartbeat(recordId)
        +ForceRelease(recordId)
        +OnConnectedAsync()
        +OnDisconnectedAsync(exception)
    }

    class ILockStore {
        <<interface>>
        +TryAcquire(recordId, userId, displayName, connectionId)
        +TryRelease(recordId, connectionId)
        +ForceRelease(recordId)
        +TryHeartbeat(recordId, connectionId)
        +GetLock(recordId)
        +GetRecordsLockedByConnection(connectionId)
        +ReleaseAllByConnection(connectionId)
    }

    class RedisLockStore {
        -IDatabase _db
        -LockStoreOptions _options
    }

    class InMemoryLockStore {
        -Dictionary _locks
    }

    class LockInfo {
        +string RecordId
        +string LockedByUserId
        +string LockedByDisplayName
        +DateTime AcquiredAtUtc
        +DateTime ExpiresAtUtc
        +string ConnectionId
    }

    class LockStoreOptions {
        +int LockTtlMs
        +int GracePeriodMs
        +int HeartbeatIntervalMs
    }

    Program --> LockController
    Program --> RecordLockHub
    LockController --> ILockStore
    RecordLockHub --> ILockStore
    ILockStore <|.. RedisLockStore
    ILockStore <|.. InMemoryLockStore
    ILockStore --> LockInfo
    RedisLockStore --> LockStoreOptions
```

### Frontend Components

```mermaid
classDiagram
    class AppComponent {
        +RouterOutlet
    }

    class RecordEditorComponent {
        +string recordId
        -LockState lockState
        -FormGroup form
        +ngOnInit()
        +ngOnChanges()
        +ngOnDestroy()
        +openEdit()
        +save()
        +cancel()
        +forceRelease()
    }

    class LockBannerComponent {
        +LockState lockState
        +string currentUserId
        +EventEmitter tryAgain
        +EventEmitter forceRelease
        +get lockedSince() string
    }

    class LockService {
        -HubConnection _connection
        -BehaviorSubject _lockState$
        -string _currentRecordId
        -number _heartbeatTimer
        -number _inactivityTimer
        +Observable~LockState~ lockState$
        +subscribeToRecord(recordId)
        +acquireLock(recordId, userId, displayName)
        +releaseLock(recordId)
        +forceRelease(recordId)
        +startHeartbeat(recordId)
    }

    class MockAuthService {
        -CurrentUser _currentUser
        +CurrentUser getCurrentUser()
        +setDisplayName(name)
        +setAdmin(isAdmin)
    }

    class LockInfo {
        +string recordId
        +string lockedByUserId
        +string lockedByDisplayName
        +string acquiredAtUtc
        +string expiresAtUtc
        +string connectionId
    }

    class LockState {
        <<type union>>
        status: unlocked
        status: owned + LockInfo
        status: locked-by-other + LockInfo
    }

    AppComponent --> RecordEditorComponent
    RecordEditorComponent --> LockBannerComponent
    RecordEditorComponent --> LockService
    RecordEditorComponent --> MockAuthService
    LockService --> LockState
    LockState --> LockInfo
```

---

## 4. Data Models

### `LockInfo` (shared between backend and frontend)

```mermaid
erDiagram
    LOCK_INFO {
        string RecordId PK "Record being locked"
        string LockedByUserId "User holding the lock"
        string LockedByDisplayName "Display name shown in UI"
        datetime AcquiredAtUtc "When lock was first acquired"
        datetime ExpiresAtUtc "TTL expiry time (AcquiredAt + 5min)"
        string ConnectionId "SignalR connection ID of holder"
    }
```

### `LockState` (frontend union type)

| Status | Fields | Meaning |
|--------|--------|---------|
| `unlocked` | — | Record is free to edit |
| `owned` | `lock: LockInfo` | Current user holds the lock |
| `locked-by-other` | `lock: LockInfo` | Another user holds the lock |

---

## 5. SignalR Hub Contract

### Client → Server Invocations

```mermaid
sequenceDiagram
    participant C as Angular Client
    participant H as RecordLockHub

    C->>H: invoke('AcquireLock', recordId, userId, displayName)
    C->>H: invoke('ReleaseLock', recordId)
    C->>H: invoke('Heartbeat', recordId)
    C->>H: invoke('ForceRelease', recordId)
```

### Server → Client Events

| Event | Recipient | Payload | Meaning |
|-------|-----------|---------|---------|
| `lockAcquired` | Group `record-{id}` | `(recordId, LockInfo)` | Lock acquired; all in group notified |
| `lockRejected` | Caller only | `(recordId, LockInfo)` | Acquisition failed; holder info included |
| `lockReleased` | Group `record-{id}` | `(recordId)` | Lock released; record now free |
| `lockHeartbeat` | Caller only | — | TTL refreshed; silent acknowledgment |
| `error` | Caller only | `(message)` | Operation failed |

---

## 6. Functional Flows

### 6.1 Application Startup

```mermaid
sequenceDiagram
    participant U as User (Browser)
    participant FE as Angular App
    participant BE as ASP.NET Core Backend
    participant R as Redis

    U->>FE: Opens app (http://localhost:4100)
    FE->>FE: MockAuth: generate/load userId & displayName from localStorage
    FE->>FE: RecordEditor ngOnInit()
    FE->>BE: GET /api/locks/{recordId}  [REST bootstrap]
    BE->>R: GET lock:{recordId}
    R-->>BE: null (unlocked) or LockInfo (locked)
    BE-->>FE: 204 No Content or 200 LockInfo
    FE->>FE: lockState$ = { status: 'unlocked' } or { status: 'locked-by-other', lock }
    FE->>BE: WebSocket connect to /hubs/recordLock
    BE-->>FE: Connection established (connectionId assigned)
    FE->>BE: JoinGroup("record-{recordId}")
    FE->>FE: UI renders: form DISABLED, banner shows lock status
```

---

### 6.2 Lock Acquisition

```mermaid
sequenceDiagram
    participant U as User A
    participant FE as LockService (Angular)
    participant H as RecordLockHub
    participant S as ILockStore
    participant R as Redis

    U->>FE: Clicks "Edit"
    FE->>FE: openEdit() → acquireLock(recordId, userId, displayName)
    FE->>H: invoke('AcquireLock', recordId, userId, displayName)

    H->>S: TryAcquire(recordId, userId, displayName, connectionId)
    S->>R: GET lock:{recordId}

    alt Lock is free
        R-->>S: null
        S->>R: SET lock:{recordId} = JSON(LockInfo), TTL=5min
        S->>R: SADD connection-locks:{connId} = recordId
        S-->>H: (true, LockInfo)
        H->>H: AddToGroupAsync("record-{recordId}")
        H->>FE: send lockAcquired (to group "record-{recordId}")
        FE->>FE: lockState$ = { status: 'owned', lock }
        FE->>FE: Form ENABLED, startHeartbeat()

    else Lock held by same user (idempotent)
        R-->>S: LockInfo (same userId)
        S->>R: Refresh TTL, update connectionId
        S-->>H: (true, LockInfo)
        H->>FE: send lockAcquired (to group)
        FE->>FE: lockState$ = { status: 'owned', lock }

    else Lock held by different user
        R-->>S: LockInfo (different userId)
        S-->>H: (false, existingLockInfo)
        H->>FE: send lockRejected (to caller ONLY)
        FE->>FE: lockState$ = { status: 'locked-by-other', lock }
        FE->>FE: Form stays DISABLED, banner shows holder info
    end
```

---

### 6.3 Active Editing (Heartbeat)

```mermaid
sequenceDiagram
    participant FE as LockService (Angular)
    participant H as RecordLockHub
    participant S as ILockStore
    participant R as Redis

    Note over FE: Heartbeat interval: every 30 seconds
    loop Every 30s while lock is owned
        FE->>H: invoke('Heartbeat', recordId)
        H->>S: TryHeartbeat(recordId, connectionId)
        S->>R: Verify lock ownership, refresh TTL=5min
        R-->>S: ok
        S-->>H: true
        H->>FE: send lockHeartbeat (to caller only)
    end

    Note over FE: Inactivity timer: 1 minute
    alt User inactive for > 1 minute
        FE->>FE: Auto-release lock (inactivity timeout)
        FE->>H: invoke('ReleaseLock', recordId)
    end
```

---

### 6.4 Lock Release

```mermaid
sequenceDiagram
    participant U as User
    participant FE as LockService (Angular)
    participant H as RecordLockHub
    participant S as ILockStore
    participant R as Redis
    participant OC as Other Clients (same record)

    U->>FE: Clicks "Save" or "Cancel"
    FE->>H: invoke('ReleaseLock', recordId)

    H->>S: TryRelease(recordId, connectionId)
    S->>R: Verify lock:{recordId} owned by connectionId
    S->>R: DEL lock:{recordId}
    S->>R: SREM connection-locks:{connId} recordId
    S-->>H: true (released)

    H->>OC: send lockReleased (broadcast to group "record-{recordId}")
    H->>FE: lockReleased included in group broadcast

    FE->>FE: Stop heartbeat timer
    FE->>FE: Stop inactivity timer
    FE->>FE: lockState$ = { status: 'unlocked' }
    FE->>FE: Form DISABLED, banner clears
```

---

### 6.5 Multi-User Conflict

```mermaid
sequenceDiagram
    participant A as User A (Lock Holder)
    participant H as RecordLockHub (Backend)
    participant B as User B (Competitor)

    Note over A,H: User A already holds the lock
    A->>H: [lock held] editing record-001

    B->>H: invoke('AcquireLock', "record-001", userB, "User B")
    H->>H: TryAcquire → lock exists, different user
    H-->>B: send lockRejected (caller only)\n{ status: 'locked-by-other', lock: {holder: UserA} }
    Note over A: No notification; A continues editing uninterrupted

    B->>B: Banner: "Locked by User A — 2m ago"\nForm stays DISABLED

    Note over A,H: User A finishes and saves
    A->>H: invoke('ReleaseLock', "record-001")
    H->>H: TryRelease → delete from Redis
    H->>A: send lockReleased (group broadcast)
    H->>B: send lockReleased (group broadcast)

    B->>B: Banner: "Unlocked — Available for editing"
    B->>H: invoke('AcquireLock', "record-001", userB, "User B")
    H->>H: TryAcquire → lock free
    H->>A: send lockAcquired (group)  "User B now editing"
    H->>B: send lockAcquired (group)
    B->>B: lockState$ = { status: 'owned' }\nForm ENABLED
```

---

### 6.6 Disconnect & Grace Period

```mermaid
sequenceDiagram
    participant A as User A (Unstable Connection)
    participant H as RecordLockHub
    participant S as ILockStore
    participant R as Redis
    participant OC as Other Clients

    Note over A: Network hiccup
    A--xH: WebSocket drops
    H->>H: OnDisconnectedAsync(connectionId)
    H->>S: GetRecordsLockedByConnection(connectionId)
    S-->>H: [record-001, record-003]
    H->>H: Start grace timer (20s)\nStore CancellationTokenSource in _graceTimers

    alt Reconnects within grace period (< 20s)
        A->>H: New WebSocket connection
        H->>H: OnConnectedAsync(newConnectionId)
        H->>H: Cancel grace timer (CTS.Cancel())
        H->>H: onreconnected fires in client
        A->>H: invoke('AcquireLock', "record-001", userId, displayName)
        H->>S: TryAcquire → same userId, refresh TTL + update connectionId
        H->>A: send lockAcquired
        Note over A: Lock held seamlessly — no gap
    else Grace period expires (> 20s offline)
        H->>S: ReleaseAllByConnection(connectionId)
        S->>R: DEL lock:{record-001}, DEL lock:{record-003}
        S->>R: DEL connection-locks:{connectionId}
        H->>OC: send lockReleased (broadcast to each record group)
        Note over OC: Other users see records unlocked\nCan now acquire locks
        A->>H: [eventually reconnects]
        A->>H: invoke('AcquireLock', "record-001", userId, ...)
        H->>H: TryAcquire → lock free
        H->>A: send lockAcquired
    end
```

---

## 7. Redis Data Structures

```mermaid
graph LR
    subgraph Redis
        L1["lock:record-001\n(String, TTL=5min)\n{\n  recordId: 'record-001',\n  lockedByUserId: 'user-abc',\n  lockedByDisplayName: 'Alice',\n  acquiredAtUtc: '...',\n  expiresAtUtc: '...',\n  connectionId: 'conn-xyz'\n}"]

        C1["connection-locks:conn-xyz\n(Set)\n{ 'record-001', 'record-003' }"]
    end

    LockInfo -- "serialized JSON" --> L1
    ConnectionTracking -- "set of recordIds" --> C1
```

| Key Pattern | Type | Content | TTL |
|-------------|------|---------|-----|
| `lock:{recordId}` | String (JSON) | Serialized `LockInfo` | 5 minutes (configurable) |
| `connection-locks:{connectionId}` | Set | Set of `recordId` strings held by this connection | None (cleaned up explicitly) |

**Operations:**

| Operation | Redis Commands |
|-----------|---------------|
| Acquire lock | `GET lock:{id}` → check → `SET lock:{id} JSON EX ttl` + `SADD connection-locks:{conn} {id}` |
| Release lock | `DEL lock:{id}` + `SREM connection-locks:{conn} {id}` |
| Heartbeat | `EXPIRE lock:{id} ttl` |
| Release all by connection | `SMEMBERS connection-locks:{conn}` → iterate DEL + `DEL connection-locks:{conn}` |

---

## 8. Key Design Patterns

### Pattern Summary

```mermaid
mindmap
  root((SignalR Locking))
    Atomicity
      Single lock per record
      Redis SET NX semantics
      No race conditions
    Resilience
      Grace period on disconnect
      CancellationToken timers
      Auto-reconnect in client
    Real-time Sync
      SignalR groups per record
      Broadcast on acquire/release
      All clients stay in sync
    Lock Lifecycle
      TTL-based expiration
      Heartbeat to refresh TTL
      Inactivity auto-release
    Idempotency
      Same user re-acquire = refresh
      Safe for reconnect flow
      No duplicate lock errors
```

### 1. Single Lock Per Record
Only one user can hold a lock on any given record at a time. Redis `SET` with `NX` semantics provides atomic, race-condition-free acquisition.

### 2. Idempotent Lock Acquisition
If the same user acquires the same lock again (e.g., after reconnect), the TTL is refreshed and the connection ID is updated. No duplicate locks are created.

### 3. TTL-Based Expiration
Redis automatically expires lock keys after 5 minutes. This means stale locks (from crashed clients) are cleaned up without a background cleanup job.

### 4. Grace Period on Disconnect
When a connection drops, locks are not immediately released. A 20-second grace period allows transient network glitches to recover without disrupting the editing session. A `CancellationTokenSource` timer fires the release only if reconnection doesn't happen in time.

### 5. Connection Tracking
Redis maintains a set of `recordId`s for each `connectionId`. This enables efficient bulk release of all locks held by a connection during grace period expiry.

### 6. Group-Based Broadcasting
All clients subscribed to a record join a SignalR group `record-{recordId}`. A single broadcast message efficiently reaches all interested clients simultaneously.

### 7. REST Bootstrap + WebSocket Updates
On page load, lock state is fetched via a single REST call (`GET /api/locks/{recordId}`) before the WebSocket is established. This prevents any state gap while the WebSocket handshake is in progress.

---

## 9. Configuration Reference

### Backend (`appsettings.json`)

```json
{
  "Redis": {
    "Connection": "localhost:6379"
  },
  "LockStore": {
    "LockTtlMs": 300000,
    "GracePeriodMs": 20000,
    "HeartbeatIntervalMs": 30000
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `Redis:Connection` | `localhost:6379` | Redis connection string |
| `LockStore:LockTtlMs` | `300000` (5 min) | How long a lock lives in Redis without a heartbeat |
| `LockStore:GracePeriodMs` | `20000` (20 s) | Time to wait before releasing locks after a disconnect |
| `LockStore:HeartbeatIntervalMs` | `30000` (30 s) | Hint to clients: how often to send heartbeats |

### Frontend (`proxy.conf.json`)

```json
{
  "/api": {
    "target": "http://localhost:5000",
    "secure": false,
    "changeOrigin": true
  },
  "/hubs": {
    "target": "http://localhost:5000",
    "secure": false,
    "changeOrigin": true,
    "ws": true
  }
}
```

The Angular dev server (`http://localhost:4100`) proxies both REST (`/api`) and WebSocket (`/hubs`) traffic to the backend (`http://localhost:5000`).

### Frontend Hardcoded Timers (`lock.ts`)

| Constant | Value | Description |
|----------|-------|-------------|
| Heartbeat interval | 30 s | Matches `HeartbeatIntervalMs` on the server |
| Inactivity timeout | 60 s | Auto-releases lock after 1 minute of no user activity |

---

## Appendix: File Map

```
signalR/
├── backend/
│   ├── SignalRLock.Api/
│   │   ├── Controllers/
│   │   │   └── LockController.cs        # REST GET /api/locks/{recordId}
│   │   ├── Hubs/
│   │   │   └── RecordLockHub.cs         # SignalR hub — core lock protocol
│   │   ├── Models/
│   │   │   └── LockInfo.cs              # Shared lock data record
│   │   ├── Services/
│   │   │   └── LockStore.cs             # ILockStore interface + Redis implementation
│   │   ├── Program.cs                   # DI setup, middleware, endpoint mapping
│   │   ├── appsettings.json             # Production configuration
│   │   └── appsettings.Development.json # Development overrides
│   ├── SignalRLock.Tests/
│   │   └── InMemoryLockStoreTests.cs    # Unit tests for lock store logic
│   └── SignalRLock.slnx                 # .NET solution file
│
├── frontend/
│   └── signalr-lock-ui/
│       └── src/app/
│           ├── models/
│           │   └── lock.model.ts        # TypeScript: LockInfo, LockState
│           ├── services/
│           │   ├── lock.ts              # LockService — SignalR client + state management
│           │   └── mock-auth.ts         # MockAuthService — localStorage identity
│           └── components/
│               ├── record-editor/       # Main editing component with lock lifecycle
│               └── lock-banner/         # Lock status display component
│
└── docs/
    └── ARCHITECTURE.md                  # ← This document
```
