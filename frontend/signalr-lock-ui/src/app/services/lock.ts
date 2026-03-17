/**
 * LockService — SignalR-backed record-level locking.
 *
 * Responsibilities:
 *  1. Manage a single shared SignalR hub connection (lazy, singleton).
 *  2. Acquire / release locks for individual records via hub methods.
 *  3. Broadcast lock-state changes through `lockState$` so the editor UI reacts.
 *  4. Keep `RecordsService` list in sync with live lock events (optimistic patch +
 *     debounced REST refresh every 300 ms after any lock event).
 *  5. Send keep-alive heartbeats every 30 s while a lock is held.
 *  6. Auto-release after 60 s of inactivity (server also enforces this).
 *  7. Reconnect transparently — re-subscribes to all hub groups on reconnect.
 */

import { Injectable, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import * as signalR from '@microsoft/signalr';
import {
  BehaviorSubject,
  Observable,
  Subject,
} from 'rxjs';
import { debounceTime, filter, first, timeout } from 'rxjs/operators';
import { LockInfo, LockState } from '../models';
import { MockAuth } from './mock-auth';
import { RecordsService } from './records.service';

// ── Configuration constants ────────────────────────────────────────
const HUB_URL = '/hubs/recordLock';
const HEARTBEAT_INTERVAL_MS = 30_000;   // ping the server every 30 s to keep the lock alive
const INACTIVITY_TIMEOUT_MS = 60_000;   // auto-release after 60 s with no user activity
const ACQUIRE_TIMEOUT_MS    = 2_500;    // max wait for hub response after AcquireLock invoke
const CONNECT_TIMEOUT_MS    = 5_000;    // max wait for initial hub connection
const REFRESH_DEBOUNCE_MS   = 300;      // collapse rapid lock events before refreshing the list

/** Return type of `acquireLock()` — tells the caller whether the lock was granted. */
export interface AcquireResult {
  acquired: boolean;
  lock?: LockInfo;
}

@Injectable({ providedIn: 'root' })
export class LockService implements OnDestroy {
  // ── Private state ────────────────────────────────────────────────
  private _connection: signalR.HubConnection | null = null;
  /** Guards concurrent callers so only one connection attempt runs at a time. */
  private _connectingPromise: Promise<void> | null = null;
  /** Tracks the lock state for whichever record the editor currently has open. */
  private _lockState$ = new BehaviorSubject<LockState>({ status: 'unlocked' });
  /** Emits true when the hub is reconnecting, false when fully reconnected. */
  private _connectionLost$ = new BehaviorSubject<boolean>(false);
  private _destroyed$ = new Subject<void>();
  /** Fires on every lock event; debounced to trigger a REST refresh of the list. */
  private _refreshTrigger$ = new Subject<void>();
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  /** The record whose lock state the editor is currently tracking. */
  private _currentRecordId: string | null = null;
  /** All record IDs the client has joined hub groups for (used to re-subscribe after reconnect). */
  private _subscribedRecordIds = new Set<string>();

  // ── Public observables ───────────────────────────────────────────
  readonly lockState$: Observable<LockState> = this._lockState$.asObservable();
  readonly connectionLost$: Observable<boolean> = this._connectionLost$.asObservable();

  constructor(
    private readonly http: HttpClient,
    private readonly auth: MockAuth,
    private readonly recordsService: RecordsService,
  ) {
    // Debounce rapid lock events (e.g. multiple users locking in quick succession)
    // before asking the backend for a fresh record list.
    this._refreshTrigger$
      .pipe(debounceTime(REFRESH_DEBOUNCE_MS))
      .subscribe(() => void this.recordsService.refresh(10));
  }

  // ── Connection management ────────────────────────────────────────

  /**
   * Ensures a live hub connection exists before any hub method is invoked.
   * Multiple concurrent callers share the same in-flight Promise so only one
   * WebSocket handshake ever happens at a time.
   */
  private async ensureConnected(): Promise<void> {
    if (this._connection?.state === signalR.HubConnectionState.Connected) return;

    if (this._connectingPromise) return this._connectingPromise;

    this._connectingPromise = this._createAndStart().finally(() => {
      this._connectingPromise = null;
    });
    return this._connectingPromise;
  }

  /** Build the HubConnection, attach reconnect hooks, register event handlers and start it. */
  private async _createAndStart(): Promise<void> {
    this._connection = new signalR.HubConnectionBuilder()
      .withUrl(HUB_URL)
      .withAutomaticReconnect()
      .configureLogging(signalR.LogLevel.Warning)
      .build();

    this._registerHubHandlers();

    // Notify the UI when connectivity is lost / restored
    this._connection.onreconnecting(() => this._connectionLost$.next(true));
    this._connection.onreconnected(async () => {
      this._connectionLost$.next(false);
      // Re-join all hub groups we were part of before the disconnect
      if (this._subscribedRecordIds.size > 0) {
        await this._connection!.invoke('SubscribeToRecords', Array.from(this._subscribedRecordIds));
      }
      this._triggerRefresh();
    });

    // Fail fast if the server doesn't respond within CONNECT_TIMEOUT_MS
    const connectTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('SignalR connect timeout')), CONNECT_TIMEOUT_MS),
    );
    await Promise.race([this._connection.start(), connectTimeout]);
    this._connectionLost$.next(false);
  }

  // ── Subscription ─────────────────────────────────────────────────

  /**
   * Subscribe to hub events for a *single* record and pre-load its current
   * lock state from the REST endpoint.  Called by the legacy RecordEditor component.
   */
  async subscribeToRecord(recordId: string): Promise<void> {
    this._stopHeartbeat();
    this._stopInactivityTimer();
    this._currentRecordId = recordId;
    this._lockState$.next({ status: 'unlocked' });

    // Pre-populate lock state from REST so the UI doesn't flicker on first render
    const existing = await this.http
      .get<LockInfo | null>(`/api/locks/${recordId}`)
      .toPromise()
      .catch(() => null);

    if (existing) {
      const status = existing.lockedByUserId === this.auth.currentUser.userId
        ? 'owned' : 'locked-by-other';
      this._lockState$.next({ status, lock: existing } as LockState);
    }

    await this.ensureConnected();
    this._subscribedRecordIds.add(recordId);
    await this._connection!.invoke('SubscribeToRecords', [recordId]);
  }

  /**
   * Join hub groups for a *batch* of record IDs.
   * Called by the records-list view so lock icons update in real time.
   * Deduplicates IDs and skips empty strings.
   */
  async subscribeToRecords(recordIds: string[]): Promise<void> {
    if (!recordIds.length) return;
    const normalized = [...new Set(recordIds.filter((id) => id.trim()))];
    normalized.forEach((id) => this._subscribedRecordIds.add(id));
    await this.ensureConnected();
    await this._connection!.invoke('SubscribeToRecords', normalized);
  }

  // ── Lock operations ──────────────────────────────────────────────

  /**
   * Ask the hub to acquire the lock for `recordId`.
   * Waits up to ACQUIRE_TIMEOUT_MS for the hub to respond with `lockAcquired`
   * or `lockRejected`, then returns an `AcquireResult`.
   *
   * On success also patches the in-memory records list optimistically so the
   * lock icon updates immediately without waiting for the next REST refresh.
   */
  async acquireLock(recordId: string): Promise<AcquireResult> {
    await this.ensureConnected();
    this._currentRecordId = recordId;
    this._lockState$.next({ status: 'unlocked' });

    const { userId, displayName } = this.auth.currentUser;
    await this._connection!.invoke('AcquireLock', recordId, userId, displayName);

    // Wait for `lockAcquired` or `lockRejected` hub events (handled in _registerHubHandlers)
    const decision = (await this._lockState$
      .pipe(
        filter((s) => s.status !== 'unlocked'),
        timeout(ACQUIRE_TIMEOUT_MS),
        first(),
      )
      .toPromise()
      .catch(() => ({ status: 'unlocked' } as LockState))) || ({ status: 'unlocked' } as LockState);

    if (decision.status === 'owned') {
      const lock = decision.lock;
      // Optimistically update the list row so the lock icon turns red immediately
      this.recordsService.patchLock(recordId, {
        isLocked: true,
        lockedByDisplayName: lock.lockedByDisplayName,
        lockedAtUtc: lock.acquiredAtUtc,
      });
      return { acquired: true, lock };
    }

    if (decision.status === 'locked-by-other') {
      return { acquired: false, lock: decision.lock };
    }

    // Timed out — treat as failed acquire
    return { acquired: false };
  }

  /**
   * Release the lock for `recordId`.
   * Optimistically clears the list row, then sends the ReleaseLock hub method.
   * Safe to call even when disconnected (skips the hub invoke in that case).
   */
  async releaseLock(recordId: string): Promise<void> {
    this._stopHeartbeat();
    this._stopInactivityTimer();

    // Optimistically clear the lock in the list before the server confirms
    this.recordsService.patchLock(recordId, {
      isLocked: false,
      lockedByDisplayName: undefined,
      lockedAtUtc: undefined,
    });

    if (this._connection?.state === signalR.HubConnectionState.Connected) {
      await this._connection.invoke('ReleaseLock', recordId);
    }
    this._lockState$.next({ status: 'unlocked' });
  }

  /**
   * Tries to release the lock, retrying once on failure.
   * Returns `true` if release succeeded, `false` if both attempts failed
   * (the lock will expire server-side via the inactivity timeout).
   */
  async releaseLockWithRetry(recordId: string): Promise<boolean> {
    try {
      await this.releaseLock(recordId);
      return true;
    } catch {
      try {
        await this.releaseLock(recordId);
        return true;
      } catch {
        return false;
      }
    }
  }

  // ── Heartbeat ────────────────────────────────────────────────────

  /**
   * Start sending periodic Heartbeat hub messages to prevent the server from
   * expiring the lock due to inactivity.  Automatically stops when the lock is
   * released or the component is destroyed.
   */
  startHeartbeat(recordId: string): void {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(async () => {
      if (
        this._connection?.state === signalR.HubConnectionState.Connected &&
        this._lockState$.value.status === 'owned'
      ) {
        await this._connection.invoke('Heartbeat', recordId);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  // ── Hub event handlers ───────────────────────────────────────────

  /**
   * Register handlers for all inbound hub events.
   * Called once when the connection is first created; the `.off()` calls
   * before each `.on()` prevent duplicate handlers if this method were
   * ever called again (defensive).
   */
  private _registerHubHandlers(): void {
    if (!this._connection) return;

    // Clear any existing handlers first (safety net)
    ['lockAcquired', 'lockRejected', 'lockReleased', 'lockHeartbeat', 'error']
      .forEach((evt) => this._connection!.off(evt));

    // ── lockAcquired ─────────────────────────────────────────────
    // Fired for every client in the record's hub group when a lock is granted.
    this._connection.on('lockAcquired', (recordId: string, lock: LockInfo) => {
      // Keep the list row in sync for all watchers (including other tabs/users)
      this.recordsService.patchLock(recordId, {
        isLocked: true,
        lockedByDisplayName: lock.lockedByDisplayName,
        lockedAtUtc: lock.acquiredAtUtc,
      });
      this._triggerRefresh();

      // Only update the editor lock-state for the record currently open
      if (recordId === this._currentRecordId) {
        if (lock.lockedByUserId === this.auth.currentUser.userId) {
          this._lockState$.next({ status: 'owned', lock });
          this._resetInactivityTimer();
        } else {
          this._lockState$.next({ status: 'locked-by-other', lock });
        }
      }
    });

    // ── lockRejected ─────────────────────────────────────────────
    // Fired only for the requesting client when the lock was already held.
    this._connection.on('lockRejected', (recordId: string, lock: LockInfo) => {
      if (recordId === this._currentRecordId) {
        this._lockState$.next({ status: 'locked-by-other', lock });
      }
    });

    // ── lockReleased ─────────────────────────────────────────────
    // Fired for every client in the group when any user releases a lock.
    this._connection.on('lockReleased', (recordId: string) => {
      this.recordsService.patchLock(recordId, {
        isLocked: false,
        lockedByDisplayName: undefined,
        lockedAtUtc: undefined,
      });
      this._triggerRefresh();

      if (recordId === this._currentRecordId) {
        this._lockState$.next({ status: 'unlocked' });
        this._stopInactivityTimer();
      }
    });

    // ── error ─────────────────────────────────────────────────────
    this._connection.on('error', (message: string) => {
      console.error('[LockService] Hub error:', message);
    });
  }

  // ── Private helpers ──────────────────────────────────────────────

  /** Debounced signal to refresh the records list after lock events settle. */
  private _triggerRefresh(): void { this._refreshTrigger$.next(); }

  private _stopHeartbeat(): void {
    if (this._heartbeatTimer !== null) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  private _stopInactivityTimer(): void {
    if (this._inactivityTimer !== null) {
      clearTimeout(this._inactivityTimer);
      this._inactivityTimer = null;
    }
  }

  /** Reset the inactivity countdown each time the user interacts while holding a lock. */
  private _resetInactivityTimer(): void {
    this._stopInactivityTimer();
    if (this._lockState$.value.status === 'owned') {
      this._inactivityTimer = setTimeout(async () => {
        if (this._currentRecordId) await this.releaseLock(this._currentRecordId);
      }, INACTIVITY_TIMEOUT_MS);
    }
  }

  ngOnDestroy(): void {
    this._destroyed$.next();
    this._destroyed$.complete();
    this._stopHeartbeat();
    this._stopInactivityTimer();
    void this._connection?.stop();
  }
}

