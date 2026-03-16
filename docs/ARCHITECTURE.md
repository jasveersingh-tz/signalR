# Architecture & Functionality Flow

> **SignalR Record-Level Locking POC**  
> A real-time, record-level exclusive editing lock system using ASP.NET Core SignalR and Angular.

---

## Table of Contents

1. [High-Level Architecture](#1-high-level-architecture)
2. [Data Models](#2-data-models)
3. [SignalR Hub Contract](#3-signalr-hub-contract)
4. [Redis Data Structures](#4-redis-data-structures)
5. [Functional Flows](#5-functional-flows)
   - [Application Startup](#51-application-startup)
   - [Lock Acquisition](#52-lock-acquisition)
   - [Active Editing (Heartbeat)](#53-active-editing-heartbeat)
   - [Lock Release](#54-lock-release)
   - [Disconnect & Grace Period](#55-disconnect--grace-period)
6. [Key Design Patterns](#6-key-design-patterns)

---

## 1. High-Level Architecture

The system consists of three layers: an **Angular frontend**, an **ASP.NET Core backend** (hosting both a REST controller and a SignalR hub), and a **Redis** store that persists lock state.

```mermaid
graph TB
    subgraph Browser["Browser (Angular 21)"]
        AppRoot["App<br/>(root component)"]
        List["RecordList<br/>Component"]
        UI["RecordEditor<br/>Component"]
        Banner["LockBanner<br/>Component"]
        LS["LockService<br/>(@microsoft/signalr client)"]
        Auth["MockAuth<br/>(localStorage)"]
        AppRoot --> List
        AppRoot --> UI
        List --> LS
        UI --> LS
        UI --> Banner
        LS --> Auth
    end

    subgraph Backend["Backend (ASP.NET Core 8)"]
        REST["LockController<br/>GET /api/locks<br/>GET /api/locks/{recordId}"]
        Hub["RecordLockHub<br/>/hubs/recordLock"]
        Store["ILockStore"]
        REST --> Store
        Hub --> Store
    end

    subgraph Storage["Storage"]
        Redis[(Redis<br/>localhost:6379)]
        Store --> Redis
    end

    LS -- "HTTP REST (bootstrap)" --> REST
    LS -- "WebSocket (SignalR)" --> Hub
```

---

## 2. Data Models

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

## 3. SignalR Hub Contract

### Client → Server Invocations

```mermaid
sequenceDiagram
    participant C as Angular Client
    participant H as RecordLockHub

    C->>H: invoke('SubscribeToAllLocks')
    C->>H: invoke('AcquireLock', recordId, userId, displayName)
    C->>H: invoke('ReleaseLock', recordId)
    C->>H: invoke('Heartbeat', recordId)
    C->>H: invoke('ForceRelease', recordId)
```

### Server → Client Events

| Event | Recipient | Payload | Meaning |
|-------|-----------|---------|---------|
| `lockAcquired` | Group `all-locks` | `(recordId, LockInfo)` | Lock acquired; all subscribers notified |
| `lockRejected` | Caller only | `(recordId, LockInfo)` | Acquisition failed; holder info included |
| `lockReleased` | Group `all-locks` | `(recordId)` | Lock released; record now free |
| `lockHeartbeat` | Caller only | `(recordId, LockInfo)` | TTL refreshed; updated lock info returned |
| `error` | Caller only | `(message)` | Operation failed |

---

## 4. Redis Data Structures

```mermaid
graph LR
    subgraph Redis
        L1["lock:record-001\n(String, TTL=5min)\n{\n  recordId: 'record-001',\n  lockedByUserId: 'user-abc',\n  lockedByDisplayName: 'Alice',\n  acquiredAtUtc: '...',\n  expiresAtUtc: '...',\n  connectionId: 'conn-xyz'\n}"]

        C1["connection-locks:conn-xyz\n(Set)\n{ 'record-001', 'record-003' }"]
    end

    LockInfo -- "serialized JSON" --> L1
    ConnectionTracking -- "set of recordIds" --> C1
```

## 5. Functional Flows

### 5.1 Application Startup

```mermaid
sequenceDiagram
    participant U as User (Browser)
    participant FE as Angular App
    participant BE as ASP.NET Core Backend
    participant R as Redis

    U->>FE: Opens app (http://localhost:4100)
    FE->>FE: MockAuth: generate/load userId & displayName from localStorage
    FE->>FE: RecordList ngOnInit()
    FE->>BE: WebSocket connect to /hubs/recordLock
    BE-->>FE: Connection established (connectionId assigned)
    FE->>BE: invoke('SubscribeToAllLocks')  [join all-locks group]
    FE->>BE: GET /api/locks  [REST bootstrap for list view]
    BE->>R: GET all lock keys
    R-->>BE: empty or LockInfo array
    BE-->>FE: 200 LockInfo array
    FE->>FE: allLocks$ populated, list renders with lock indicators
    U->>FE: Clicks a record row
    FE->>FE: RecordEditor ngOnInit() for selected recordId
    FE->>BE: GET /api/locks/recordId  [REST bootstrap for editor]
    BE->>R: GET lock for recordId
    R-->>BE: null (unlocked) or LockInfo (locked)
    BE-->>FE: 204 No Content or 200 LockInfo
    FE->>FE: lockState$ set to unlocked or locked-by-other
    FE->>FE: RecordEditor auto-invokes openEdit() then acquireLock(...)
```

---

### 5.2 Lock Acquisition

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
        H->>FE: send lockAcquired (to group "all-locks")
        FE->>FE: lockState$ = { status: 'owned', lock }
        FE->>FE: Form ENABLED, startHeartbeat()

    else Lock held by same user (idempotent)
        R-->>S: LockInfo (same userId)
        S->>R: Refresh TTL, update connectionId
        S-->>H: (true, LockInfo)
        H->>FE: send lockAcquired (to group "all-locks")
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

### 5.3 Active Editing (Heartbeat)

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

    Note over FE: Inactivity timer: 5 minutes
    alt User inactive for > 5 minutes
        FE->>FE: Auto-release lock (inactivity timeout)
        FE->>H: invoke('ReleaseLock', recordId)
    end
```

---

### 5.4 Lock Release

```mermaid
sequenceDiagram
    participant U as User
    participant FE as LockService (Angular)
    participant H as RecordLockHub
    participant S as ILockStore
    participant R as Redis
    participant OC as Other Clients (all-locks group)

    U->>FE: Clicks "Save" or "Cancel"
    FE->>H: invoke('ReleaseLock', recordId)

    H->>S: TryRelease(recordId, connectionId)
    S->>R: Verify lock:{recordId} owned by connectionId
    S->>R: DEL lock:{recordId}
    S->>R: SREM connection-locks:{connId} recordId
    S-->>H: true (released)

    H->>OC: send lockReleased (broadcast to group "all-locks")
    Note over FE,OC: Caller receives lockReleased as a member of all-locks group

    FE->>FE: Stop heartbeat timer
    FE->>FE: Stop inactivity timer
    FE->>FE: lockState$ = { status: 'unlocked' }
    FE->>FE: Form DISABLED, banner clears
```

---

### 5.5 Disconnect & Grace Period

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
        H->>OC: send lockReleased (broadcast to group "all-locks")
        Note over OC: Other users see records unlocked\nCan now acquire locks
        A->>H: [eventually reconnects]
        A->>H: invoke('AcquireLock', "record-001", userId, ...)
        H->>H: TryAcquire → lock free
        H->>A: send lockAcquired
    end
```

---


## 6. Key Design Patterns

### Pattern Summary

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

### 6. Single Shared Broadcast Group
All clients join a single SignalR group `all-locks` via `SubscribeToAllLocks`. Every `lockAcquired` and `lockReleased` event is broadcast to this group, so any connected client (list view or editor) immediately sees lock changes across all records without needing per-record group subscriptions.

### 7. REST Bootstrap + WebSocket Updates
On page load, lock state is fetched via REST before WebSocket events begin. The list view calls `GET /api/locks` (all active locks) to populate its initial state. The editor calls `GET /api/locks/{recordId}` when a record is selected. Both calls prevent state gaps while the WebSocket handshake is in progress.

---
