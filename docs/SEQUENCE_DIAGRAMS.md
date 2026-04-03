# SignalR Lock POC Sequence Diagrams

## Overview
These diagrams cover the main runtime behaviors in the repository: identity initialization, list subscription, editor acquisition, reconnect handling, disconnect grace release, and admin force release.

## 1. Authentication And Frontend Initialization

```mermaid
sequenceDiagram
    autonumber
    participant Browser
    participant App as Angular App
    participant Auth as MockAuth
    participant Storage as localStorage

    Browser->>App: Load SPA
    App->>Auth: construct MockAuth
    Auth->>Storage: getItem("mockUser")
    alt Stored identity exists
        Storage-->>Auth: stored JSON user
        Auth-->>App: currentUser
    else No stored identity
        Auth->>Auth: generate userId and displayName
        Auth->>Storage: setItem("mockUser", user)
        Auth-->>App: currentUser
    end
```

## 2. List View Subscription And Bootstrap

```mermaid
sequenceDiagram
    autonumber
    participant List as RecordList
    participant Service as LockService
    participant Hub as RecordLockHub
    participant Api as LockController
    participant Store as ILockStore

    List->>Service: subscribe to allLocks$
    List->>Service: subscribeToAllLocks("ARPO")
    Service->>Service: ensureConnected("ARPO")
    Service->>Hub: invoke SubscribeToAllLocks()
    Service->>Api: GET /api/locks?feature=ARPO
    Api->>Store: GetAllLocksAsync("ARPO")
    Store-->>Api: LockInfo[]
    Api-->>Service: 200 OK LockInfo[]
    Service->>Service: build Map<string, LockInfo>
    Service-->>List: allLocks$ emits map
    List->>List: cdr.markForCheck()
```

## 3. Record Open And Lock Acquisition

```mermaid
sequenceDiagram
    autonumber
    participant Editor as RecordEditor
    participant Service as LockService
    participant Api as LockController
    participant Hub as RecordLockHub
    participant Store as ILockStore
    participant Redis

    Editor->>Service: subscribeToRecord(recordId, "ARPO")
    Service->>Api: GET /api/locks/{recordId}?feature=ARPO
    alt Existing lock found
        Api-->>Service: 200 LockInfo
        Service-->>Editor: lockState = locked-by-other
    else No active lock
        Api-->>Service: 204 No Content
        Service-->>Editor: lockState = unlocked
    end
    Editor->>Service: acquireLock(recordId, userId, displayName)
    Service->>Hub: invoke AcquireLock(recordId, userId, displayName)
    Hub->>Store: TryAcquireAsync(feature, recordId, userId, displayName, connectionId, ttl)
    Store->>Redis: GET lock:{feature}:{recordId}
    alt Free or same owner
        Store->>Redis: SET lock key with TTL
        Store->>Redis: SADD connection-locks set
        Hub-->>Service: lockAcquired(recordId, lock)
        Service-->>Editor: lockState = owned
    else Held by other user
        Hub-->>Service: lockRejected(recordId, existingLock)
        Service-->>Editor: lockState = locked-by-other
    end
```

## 4. Reconnect And Lock Reassertion

```mermaid
sequenceDiagram
    autonumber
    participant Client as LockService
    participant Hub as RecordLockHub

    Client->>Hub: automatic reconnect
    Hub-->>Client: reconnected callback
    opt Current lock state is owned
        Client->>Hub: AcquireLock(recordId, lockedByUserId, lockedByDisplayName)
        Hub-->>Client: lockAcquired(recordId, lock)
        Client->>Client: startHeartbeat(recordId)
    end
```

## 5. Disconnect With Grace Period And Deferred Release

```mermaid
sequenceDiagram
    autonumber
    participant Client as Browser Connection
    participant Hub as RecordLockHub
    participant Store as ILockStore
    participant Group as SignalR Group Subscribers

    Client-xHub: disconnect
    Hub->>Store: GetRecordsLockedByConnectionAsync(feature, connectionId)
    alt No held locks
        Hub->>Hub: complete disconnect immediately
    else Held locks exist
        Hub->>Hub: start CancellationTokenSource grace timer
        opt Client reconnects before grace expiry
            Hub->>Hub: cancel grace timer
        else Grace expires
            Hub->>Store: ReleaseAllByConnectionAsync(feature, connectionId)
            loop Each released lock
                Hub-->>Group: lockReleased(recordId)
            end
        end
    end
```

## 6. Admin Force Release

```mermaid
sequenceDiagram
    autonumber
    participant Admin as Admin User
    participant Editor as RecordEditor
    participant Service as LockService
    participant Hub as RecordLockHub
    participant Store as ILockStore
    participant Group as Subscribers

    Admin->>Editor: Click force unlock
    Editor->>Service: forceRelease(recordId)
    Service->>Hub: invoke ForceRelease(recordId)
    Hub->>Store: ForceReleaseAsync(feature, recordId)
    alt Lock existed
        Store-->>Hub: removed LockInfo
        Hub-->>Group: lockReleased(recordId)
    else No lock existed
        Store-->>Hub: null
    end
```

## Cross References
- System structure: [ARCHITECTURE.md](ARCHITECTURE.md)
- Endpoint and event details: [API_REFERENCE.md](API_REFERENCE.md)
- Lock rules: [BUSINESS_LOGIC.md](BUSINESS_LOGIC.md)

## Version History
| Version | Date | Changes |
|---|---|---|
| 1.0 | 2026-04-03 | Added six sequence diagrams covering bootstrap, acquisition, reconnect, release, and admin override |