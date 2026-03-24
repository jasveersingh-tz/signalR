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
 *  6. Track real user activity (mouse / keyboard) and emit `inactivityWarning$`
 *     after 30 minutes of no activity while a lock is held.
 *  7. Support lock-transfer flow: request, approve, reject (with 5-min cooldown).
 *  8. Reconnect transparently — re-subscribes to all hub groups on reconnect.
 */

import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import * as signalR from '@microsoft/signalr';
import {
  BehaviorSubject,
  Observable,
  Subject,
} from 'rxjs';
import { debounceTime, filter, first, timeout } from 'rxjs/operators';
import { LockInfo, LockState, LockTransferInfo } from '../models';
import { MockAuth } from './mock-auth';
import { RecordsService } from './records.service';

// ── Configuration constants ────────────────────────────────────────
const HUB_URL = '/hubs/recordLock';
const HEARTBEAT_INTERVAL_MS  = 30_000;       // ping the server every 30 s to keep the lock alive
const INACTIVITY_WARNING_MS  = 10_000;       // show inactivity modal after 10 sec of no activity (for testing)
const ACQUIRE_TIMEOUT_MS     = 2_500;        // max wait for hub response after AcquireLock invoke
const CONNECT_TIMEOUT_MS     = 5_000;        // max wait for initial hub connection
const REFRESH_DEBOUNCE_MS    = 300;          // collapse rapid lock events before refreshing the list
const UNLOAD_RELEASE_TIMEOUT = 1_000;        // max wait for unload lock release (ms)

// Events on the document that reset the inactivity countdown
const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click', 'touchstart'] as const;

/** Return type of `acquireLock()` — tells the caller whether the lock was granted. */
export interface AcquireResult {
  acquired: boolean;
  lock?: LockInfo;
}

@Injectable({ providedIn: 'root' })
export class LockService implements OnDestroy {
  // ── Private state ────────────────────────────────────────────────
  private _connection: signalR.HubConnection | null = null;
  private _connectingPromise: Promise<void> | null = null;
  private _lockState$ = new BehaviorSubject<LockState>({ status: 'unlocked' });
  private _connectionLost$ = new BehaviorSubject<boolean>(false);
  private _destroyed$ = new Subject<void>();
  private _refreshTrigger$ = new Subject<void>();
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private _currentRecordId: string | null = null;
  private _subscribedRecordIds = new Set<string>();

  /** Bound handler reference kept so it can be removed from document listeners. */
  private _activityHandler = () => this._onUserActivity();
  private _activityTracking = false;
  private _releaseOnUnloadHandler = () => this._releaseLockOnUnload();

  // ── Public observables ───────────────────────────────────────────

  readonly lockState$: Observable<LockState>   = this._lockState$.asObservable();
  readonly connectionLost$: Observable<boolean> = this._connectionLost$.asObservable();

  /**
   * Fires when the user has been idle for 30 minutes while holding a lock.
   * The dialog subscribes and shows the "extend or close session" modal.
   */
  private _inactivityWarning$ = new Subject<void>();
  readonly inactivityWarning$: Observable<void> = this._inactivityWarning$.asObservable();

  /**
   * Fires on the lock HOLDER's side when another user requests access to the record.
   * The dialog subscribes and shows the approve / reject modal.
   */
  private _lockTransferRequested$ = new Subject<LockTransferInfo>();
  readonly lockTransferRequested$: Observable<LockTransferInfo> = this._lockTransferRequested$.asObservable();

  /**
   * Fires on the REQUESTER's side when the holder approves the transfer.
   * The view-only dialog uses this to trigger a direct `acquireLock()` call.
   */
  private _lockTransferApproved$ = new Subject<string>();          // emits recordId
  readonly lockTransferApproved$: Observable<string> = this._lockTransferApproved$.asObservable();

  /**
   * Fires on the REQUESTER's side when the holder rejects the transfer.
   */
  private _lockTransferRejected$ = new Subject<string>();          // emits recordId
  readonly lockTransferRejected$: Observable<string> = this._lockTransferRejected$.asObservable();

  /**
   * Fires when a cooldown is blocking a new transfer request.
   * Payload: { recordId, remainingSeconds }
   */
  private _lockTransferCooldown$ = new Subject<{ recordId: string; remainingSeconds: number }>();
  readonly lockTransferCooldown$: Observable<{ recordId: string; remainingSeconds: number }> =
    this._lockTransferCooldown$.asObservable();

  /**
   * Fires when the lock expired (released) just as a transfer was being requested.
   * Requester should try a direct acquire.
   */
  private _lockTransferExpired$ = new Subject<string>();           // emits recordId
  readonly lockTransferExpired$: Observable<string> = this._lockTransferExpired$.asObservable();

  constructor(
    private readonly http: HttpClient,
    private readonly auth: MockAuth,
    private readonly recordsService: RecordsService,
    private readonly _zone: NgZone,
  ) {
    this._refreshTrigger$
      .pipe(debounceTime(REFRESH_DEBOUNCE_MS))
      .subscribe(() => this._zone.run(() => void this.recordsService.refresh(10)));

    // Browser refresh/close can tear down SignalR before async release invokes finish.
    window.addEventListener('pagehide', this._releaseOnUnloadHandler);
    window.addEventListener('beforeunload', this._releaseOnUnloadHandler);
  }

  // ── Connection management ────────────────────────────────────────

  private async ensureConnected(): Promise<void> {
    if (this._connection?.state === signalR.HubConnectionState.Connected) return;
    if (this._connectingPromise) return this._connectingPromise;

    this._connectingPromise = this._createAndStart().finally(() => {
      this._connectingPromise = null;
    });
    return this._connectingPromise;
  }

  private async _createAndStart(): Promise<void> {
    this._connection = new signalR.HubConnectionBuilder()
      .withUrl(HUB_URL)
      .withAutomaticReconnect()
      .configureLogging(signalR.LogLevel.Warning)
      .build();

    this._registerHubHandlers();

    this._connection.onreconnecting(() => this._connectionLost$.next(true));
    this._connection.onreconnected(async () => {
      this._connectionLost$.next(false);
      // Re-subscribe to all locks on reconnect
      await this._connection!.invoke('SubscribeToAllLocks');
      this._triggerRefresh();
    });

    const connectTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('SignalR connect timeout')), CONNECT_TIMEOUT_MS),
    );
    await Promise.race([this._connection.start(), connectTimeout]);
    this._connectionLost$.next(false);

    // Subscribe to all lock updates (backend broadcasts to this group)
    await this._connection.invoke('SubscribeToAllLocks');
  }

  // ── Subscription ─────────────────────────────────────────────────

  async subscribeToRecord(recordId: string): Promise<void> {
    this._stopHeartbeat();
    this._stopInactivityTimer();
    this._currentRecordId = recordId;
    this._lockState$.next({ status: 'unlocked' });

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
    // Backend broadcasts all locks to SubscribeToAllLocks group, so just ensure connected
  }

  async subscribeToRecords(recordIds: string[]): Promise<void> {
    if (!recordIds.length) return;
    await this.ensureConnected();
    // Backend broadcasts all locks to SubscribeToAllLocks group
  }

  async getLockInfo(recordId: string): Promise<LockInfo | null> {
    if (!recordId?.trim()) return null;
    return this.http
      .get<LockInfo | null>(`/api/locks/${recordId}`)
      .toPromise()
      .catch(() => null);
  }

  // ── Lock operations ──────────────────────────────────────────────

  async acquireLock(recordId: string): Promise<AcquireResult> {
    await this.ensureConnected();
    this._currentRecordId = recordId;
    this._lockState$.next({ status: 'unlocked' });

    const { userId, displayName } = this.auth.currentUser;
    await this._connection!.invoke('AcquireLock', recordId, userId, displayName);

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

    return { acquired: false };
  }

  async releaseLock(recordId: string): Promise<void> {
    this._stopHeartbeat();
    this._stopInactivityTimer();

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

  // ── Lock transfer ─────────────────────────────────────────────────

  /**
   * Send a request to the current lock holder asking them to transfer the lock.
   * The holder will receive a `lockTransferRequested` hub event (shown as an in-dialog modal).
   */
  async requestLockTransfer(recordId: string): Promise<void> {
    await this.ensureConnected();
    const { userId, displayName } = this.auth.currentUser;
    await this._connection!.invoke('RequestAccess', recordId, userId, displayName);
  }

  /**
   * Called by the lock holder to approve a pending transfer request.
   * The holder's lock is released server-side; the requester gets `lockTransferApproved`.
   */
  async approveLockTransfer(recordId: string, requesterUserId: string, requesterDisplayName: string, requesterConnectionId: string): Promise<void> {
    await this.ensureConnected();
    await this._connection!.invoke('AcceptAccessRequest', recordId, requesterUserId, requesterDisplayName, requesterConnectionId);
  }

  /**
   * Called by the lock holder to reject a pending transfer request.
   * The requester gets `lockTransferRejected`.
   */
  async rejectLockTransfer(recordId: string, requesterConnectionId: string): Promise<void> {
    await this.ensureConnected();
    await this._connection!.invoke('RejectAccessRequest', recordId, requesterConnectionId);
  }

  // ── Heartbeat ────────────────────────────────────────────────────

  startHeartbeat(recordId: string): void {
    this._stopHeartbeat();
    this._startActivityTracking();
    this._heartbeatTimer = setInterval(async () => {
      if (
        this._connection?.state === signalR.HubConnectionState.Connected &&
        this._lockState$.value.status === 'owned'
      ) {
        await this._connection.invoke('Heartbeat', recordId);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Reset the 30-minute inactivity countdown; called when the user clicks "Extend Session".
   */
  extendSession(): void {
    this._resetInactivityTimer();
  }

  // ── Activity tracking ─────────────────────────────────────────────

  private _startActivityTracking(): void {
    if (this._activityTracking) return;
    this._activityTracking = true;
    ACTIVITY_EVENTS.forEach((evt) =>
      document.addEventListener(evt, this._activityHandler, { passive: true }),
    );
    this._resetInactivityTimer();
  }

  private _stopActivityTracking(): void {
    if (!this._activityTracking) return;
    ACTIVITY_EVENTS.forEach((evt) =>
      document.removeEventListener(evt, this._activityHandler),
    );
    this._activityTracking = false;
  }

  private _onUserActivity(): void {
    if (this._lockState$.value.status === 'owned') {
      this._resetInactivityTimer();
    }
  }

  // ── Hub event handlers ───────────────────────────────────────────

  private _registerHubHandlers(): void {
    if (!this._connection) return;

    [
      'lockAcquired', 'lockRejected', 'lockReleased', 'lockHeartbeat', 'error',
      'lockTransferRequested', 'lockTransferApproved', 'lockTransferRejected',
      'lockTransferCooldown', 'lockTransferExpired',
    ].forEach((evt) => this._connection!.off(evt));

    // ── lockAcquired ──────────────────────────────────────────────
    this._connection.on('lockAcquired', (recordId: string, lock: LockInfo) => {
      this._zone.run(() => {
        this.recordsService.patchLock(recordId, {
          isLocked: true,
          lockedByDisplayName: lock.lockedByDisplayName,
          lockedAtUtc: lock.acquiredAtUtc,
        });

        if (recordId === this._currentRecordId) {
          if (lock.lockedByUserId === this.auth.currentUser.userId) {
            this._lockState$.next({ status: 'owned', lock });
            this._resetInactivityTimer();
          } else {
            this._lockState$.next({ status: 'locked-by-other', lock });
          }
        }
      });
    });

    // ── lockRejected ──────────────────────────────────────────────
    this._connection.on('lockRejected', (recordId: string, lock: LockInfo) => {
      this._zone.run(() => {
        if (recordId === this._currentRecordId) {
          this._lockState$.next({ status: 'locked-by-other', lock });
        }
      });
    });

    // ── lockReleased ──────────────────────────────────────────────
    this._connection.on('lockReleased', (recordId: string) => {
      this._zone.run(() => {
        this.recordsService.patchLock(recordId, {
          isLocked: false,
          lockedByDisplayName: undefined,
          lockedAtUtc: undefined,
        });

        if (recordId === this._currentRecordId) {
          this._lockState$.next({ status: 'unlocked' });
          this._stopInactivityTimer();
        }
      });
    });

    // ── error ─────────────────────────────────────────────────────
    this._connection.on('error', (message: string) => {
      this._zone.run(() => {
        console.error('[LockService] Hub error:', message);
      });
    });

    // ── lockTransferRequested (holder receives) ───────────────────
    this._connection.on(
      'lockRequested',
      (payload: { recordId: string; requesterId: string; requesterDisplayName: string; requesterConnectionId: string }) => {
        this._zone.run(() => {
          this._lockTransferRequested$.next({
            recordId: payload.recordId,
            requestingUserId: payload.requesterId,
            requestingDisplayName: payload.requesterDisplayName,
            requesterConnectionId: payload.requesterConnectionId,
          });
        });
      },
    );

    // ── lockTransferApproved (requester receives) ─────────────────
    this._connection.on('lockTransferApproved', (recordId: string) => {
      this._zone.run(() => this._lockTransferApproved$.next(recordId));
    });

    // ── lockTransferRejected (requester receives) ─────────────────
    this._connection.on('lockTransferRejected', (recordId: string) => {
      this._zone.run(() => this._lockTransferRejected$.next(recordId));
    });

    // ── lockTransferCooldown (requester receives) ─────────────────
    this._connection.on('lockTransferCooldown', (recordId: string, remainingSeconds: number) => {
      this._zone.run(() => this._lockTransferCooldown$.next({ recordId, remainingSeconds }));
    });

    // ── lockTransferExpired ───────────────────────────────────────
    this._connection.on('lockTransferExpired', (recordId: string) => {
      this._zone.run(() => this._lockTransferExpired$.next(recordId));
    });
  }

  // ── Private helpers ──────────────────────────────────────────────

  private _triggerRefresh(): void { this._refreshTrigger$.next(); }

  private _stopHeartbeat(): void {
    if (this._heartbeatTimer !== null) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    this._stopActivityTracking();
  }

  private _stopInactivityTimer(): void {
    if (this._inactivityTimer !== null) {
      clearTimeout(this._inactivityTimer);
      this._inactivityTimer = null;
    }
  }

  /**
   * Restart the 30-minute inactivity countdown.
   * When it fires, `inactivityWarning$` notifies the dialog to show the extend/close modal.
   */
  private _resetInactivityTimer(): void {
    this._stopInactivityTimer();
    if (this._lockState$.value.status === 'owned') {
      this._inactivityTimer = setTimeout(() => {
        this._inactivityWarning$.next();
      }, INACTIVITY_WARNING_MS);
    }
  }

  ngOnDestroy(): void {
    this._destroyed$.next();
    this._destroyed$.complete();
    this._stopHeartbeat();
    this._stopInactivityTimer();
    window.removeEventListener('pagehide', this._releaseOnUnloadHandler);
    window.removeEventListener('beforeunload', this._releaseOnUnloadHandler);
    void this._connection?.stop();
  }

  private _releaseLockOnUnload(): void {
    this._stopHeartbeat();
    
    const current = this._lockState$.value;
    if (current.status !== 'owned') return;

    const recordId = current.lock?.recordId ?? this._currentRecordId;
    if (!recordId) return;

    try {
      // Attempt to release the lock via SignalR if connected
      if (this._connection?.state === signalR.HubConnectionState.Connected) {
        console.log('[LockService] Releasing lock on page unload:', recordId);
        // Send the release and wait briefly for it to complete
        this._connection.invoke('ReleaseLock', recordId)
          .then(() => {
            console.log('[LockService] Lock released successfully on unload:', recordId);
            // Stop connection after release
            void this._connection?.stop();
          })
          .catch((err) => {
            console.warn('[LockService] Error releasing lock on unload:', err);
            // Still try to stop the connection
            void this._connection?.stop();
          });
        
        // Set a timeout fallback to stop the connection even if release fails
        setTimeout(() => {
          if (this._connection?.state === signalR.HubConnectionState.Connected) {
            console.log('[LockService] Force-stopping connection after unload timeout');
            void this._connection.stop();
          }
        }, UNLOAD_RELEASE_TIMEOUT);
      }
    } catch (err) {
      console.error('[LockService] Unload cleanup error:', err);
    }
  }
}
