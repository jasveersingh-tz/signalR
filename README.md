# signalR
SignalR implementation to lock records when someone trying to edit record which is already been opened by other user

## Record-Level Locking POC

A proof-of-concept for real-time, record-level exclusive editing locks using **ASP.NET Core 8 + SignalR** (backend) and **Angular 21** (frontend).

### Architecture

```
┌─────────────────────────────┐      WebSocket / SignalR      ┌──────────────────────────┐
│   Angular 21 (frontend)     │ ◄────────────────────────────► │  ASP.NET Core 8 (backend) │
│  LockService + RecordEditor │                                 │  RecordLockHub            │
│  @microsoft/signalr client  │      REST (bootstrap)          │  InMemoryLockStore        │
│                             │ ◄────────────────────────────► │  GET /api/locks/:recordId │
└─────────────────────────────┘                                └──────────────────────────┘
```

### Features Implemented

| Feature | Status |
|---------|--------|
| Acquire lock on edit open | ✅ |
| Release lock on Save/Cancel | ✅ |
| Auto-unlock on disconnect (grace period) | ✅ |
| Stale lock TTL with heartbeat | ✅ |
| Show lock holder in UI banner | ✅ |
| Try Again CTA for blocked users | ✅ |
| Admin force-release | ✅ |
| Reconnect re-asserts lock | ✅ |
| Single lock per record (atomic) | ✅ |
| REST bootstrap for page refresh | ✅ |
| beforeunload best-effort release | ✅ |

### Quick Start

**Backend**
```bash
cd backend
dotnet run --project SignalRLock.Api
# Listens on http://localhost:5000
```

**Frontend**
```bash
cd frontend/signalr-lock-ui
npm install
ng serve
# Opens at http://localhost:4200
# Proxies /api and /hubs to http://localhost:5000
```

Open multiple browser tabs to observe locking behaviour in real time.

### Configuration

Backend lock settings (`backend/SignalRLock.Api/appsettings.json`):

| Key | Default | Description |
|-----|---------|-------------|
| `LockStore:LockTtlMs` | 300000 | Lock TTL (5 min) |
| `LockStore:GracePeriodMs` | 20000 | Disconnect grace period (20 s) |
| `LockStore:HeartbeatIntervalMs` | 30000 | Heartbeat interval hint (30 s) |

### SignalR Hub Contract

**Client → Server**

| Method | Parameters | Description |
|--------|-----------|-------------|
| `AcquireLock` | `recordId, userId, displayName` | Request exclusive edit lock |
| `ReleaseLock` | `recordId` | Release your lock |
| `Heartbeat` | `recordId` | Extend TTL |
| `ForceRelease` | `recordId` | Admin: force-remove any lock |

**Server → Client**

| Event | Parameters | Description |
|-------|-----------|-------------|
| `lockAcquired` | `recordId, LockInfo` | Lock granted; broadcast to record group |
| `lockRejected` | `recordId, LockInfo` | Lock denied; sent to caller only |
| `lockReleased` | `recordId` | Lock removed; broadcast to record group |
| `lockHeartbeat` | `recordId, LockInfo` | TTL refreshed; sent to caller only |
| `error` | `message` | Error message; sent to caller only |

### Running Tests

```bash
# Backend (xUnit)
cd backend && dotnet test

# Frontend (Vitest)
cd frontend/signalr-lock-ui && ng test --watch=false
```

### Security Notes (POC vs Production)

- **POC**: Mock auth (`MockAuth` service stores user in `localStorage`).
- **Production**: Use JWT/Identity; read `Context.User` in the hub; do not trust client-provided `userId/displayName`.
- **Scale-out**: Replace `InMemoryLockStore` with a Redis-backed store and add SignalR backplane.
- **.NET version**: .NET 5 is EOL; this POC uses .NET 8 LTS.
