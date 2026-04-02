import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import * as signalR from '@microsoft/signalr';
import {
  BehaviorSubject,
  Observable,
  Subject,
  firstValueFrom,
} from 'rxjs';
import { LockInfo, LockState } from '../models/lock.model';
import { MockAuth } from './mock-auth';

const HUB_BASE_URL = '/hubs/locks';
const HEARTBEAT_INTERVAL_MS = 30_000;
const INACTIVITY_TIMEOUT_MS = 300_000;

@Injectable({ providedIn: 'root' })
export class LockService implements OnDestroy {
  private _connection: signalR.HubConnection | null = null;
  private _lockState$ = new BehaviorSubject<LockState>({ status: 'unlocked' });
  private _destroyed$ = new Subject<void>();
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private _currentRecordId: string | null = null;
  private _lastActivityTime: number = Date.now();
  private _featureKey: string = 'default';

  private _allLocks$ = new BehaviorSubject<Map<string, LockInfo>>(new Map());

  /** Observable of the current lock state for the active record. */
  readonly lockState$: Observable<LockState> = this._lockState$.asObservable();

  /** Observable of all active locks (recordId → LockInfo). Used by the list view. */
  readonly allLocks$: Observable<Map<string, LockInfo>> = this._allLocks$.asObservable();

  constructor(private http: HttpClient, private zone: NgZone, private auth: MockAuth) {}

  // ── Connection ──────────────────────────────────────────────────────────────

  private async ensureConnected(featureKey: string): Promise<void> {
    // If already connected with the same featureKey, nothing to do
    if (
      this._connection &&
      this._connection.state === signalR.HubConnectionState.Connected &&
      this._featureKey === featureKey
    ) {
      return;
    }

    // featureKey changed or no connection — stop the old one first
    if (this._connection) {
      await this._connection.stop();
      this._connection = null;
    }

    this._featureKey = featureKey;

    this._connection = new signalR.HubConnectionBuilder()
      .withUrl(`${HUB_BASE_URL}?feature=${encodeURIComponent(featureKey)}`)
      .withAutomaticReconnect()
      .configureLogging(signalR.LogLevel.Information)
      .build();

    this._registerHubHandlers();

    this._connection.onreconnected(async () => {
      console.log('[LockService] Reconnected.');
      if (this._lockState$.value.status === 'owned') {
        const state = this._lockState$.value;
        await this._connection!.invoke(
          'AcquireLock',
          state.lock.recordId,
          state.lock.lockedByUserId,
          state.lock.lockedByDisplayName,
        );
        this.startHeartbeat(state.lock.recordId);
      }
    });

    await this._connection.start();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Bootstrap lock state from REST, then connect to the hub for this feature.
   * Call this when an edit view initialises.
   * @param recordId  The record being opened for editing.
   * @param featureKey  The feature this screen belongs to (e.g. 'purchase-orders').
   *                    Defaults to 'default' so existing call sites require no change.
   */
  async subscribeToRecord(recordId: string, featureKey = 'default'): Promise<void> {
    this._stopHeartbeat();
    this._stopInactivityTimer();

    this._currentRecordId = recordId;
    this._lockState$.next({ status: 'unlocked' });

    if (this._connection) {
      this._registerHubHandlers();
    }

    // Bootstrap current state via REST before the hub connection is open
    try {
      const existing = await firstValueFrom(
        this.http.get<LockInfo | null>(
          `/api/locks/${recordId}?feature=${encodeURIComponent(featureKey)}`,
          { observe: 'body' },
        ),
      ).catch(() => null);

      if (existing) {
        this._lockState$.next({ status: 'locked-by-other', lock: existing });
      }
    } catch {
      // Non-critical — hub events will correct state
    }

    await this.ensureConnected(featureKey);
  }

  /**
   * Subscribe to lock changes for all records in a feature. Used by list views.
   * @param featureKey  The feature this screen belongs to. Defaults to 'default'.
   */
  async subscribeToAllLocks(featureKey = 'default'): Promise<void> {
    await this.ensureConnected(featureKey);
    await this._connection!.invoke('SubscribeToAllLocks');

    try {
      const locks = await firstValueFrom(
        this.http.get<LockInfo[]>(
          `/api/locks?feature=${encodeURIComponent(featureKey)}`,
        ),
      ).catch(() => [] as LockInfo[]);

      const map = new Map<string, LockInfo>();
      for (const lock of locks) {
        map.set(lock.recordId, lock);
      }
      this._allLocks$.next(map);
    } catch {
      // Non-critical — hub events will correct state
    }
  }

  /** Attempt to acquire the lock for the current record. */
  async acquireLock(
    recordId: string,
    userId: string,
    displayName: string,
  ): Promise<void> {
    await this.ensureConnected(this._featureKey);
    await this._connection!.invoke('AcquireLock', recordId, userId, displayName);
    this._setupActivityListeners();
    this._resetInactivityTimer();
  }

  /** Release the lock for a record. */
  async releaseLock(recordId: string): Promise<void> {
    if (
      !this._connection ||
      this._connection.state !== signalR.HubConnectionState.Connected
    ) {
      return;
    }
    this._stopHeartbeat();
    this._stopInactivityTimer();
    await this._connection.invoke('ReleaseLock', recordId);
    this._lockState$.next({ status: 'unlocked' });
  }

  /** Admin: force-release any lock on a record. */
  async forceRelease(recordId: string): Promise<void> {
    await this.ensureConnected(this._featureKey);
    await this._connection!.invoke('ForceRelease', recordId);
  }

  /** Start sending heartbeats to keep the lock alive. */
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

  private _registerHubHandlers(): void {
    if (!this._connection) return;

    this._connection.off('lockAcquired');
    this._connection.off('lockRejected');
    this._connection.off('lockReleased');
    this._connection.off('lockHeartbeat');
    this._connection.off('error');

    this._connection.on('lockAcquired', (recordId: string, lock: LockInfo) => {
      this.zone.run(() => {
        if (recordId === this._currentRecordId) {
          const isOwnLock = lock.lockedByUserId === this.auth.currentUser.userId;
          this._lockState$.next(
            isOwnLock
              ? { status: 'owned', lock }
              : { status: 'locked-by-other', lock },
          );
        }
        const acquireMap = new Map(this._allLocks$.value);
        acquireMap.set(recordId, lock);
        this._allLocks$.next(acquireMap);
      });
    });

    this._connection.on('lockRejected', (recordId: string, lock: LockInfo) => {
      this.zone.run(() => {
        if (recordId === this._currentRecordId) {
          this._lockState$.next({ status: 'locked-by-other', lock });
        }
        const rejectMap = new Map(this._allLocks$.value);
        rejectMap.set(recordId, lock);
        this._allLocks$.next(rejectMap);
      });
    });

    this._connection.on('lockReleased', (recordId: string) => {
      this.zone.run(() => {
        if (recordId === this._currentRecordId) {
          this._lockState$.next({ status: 'unlocked' });
        }
        const releaseMap = new Map(this._allLocks$.value);
        releaseMap.delete(recordId);
        this._allLocks$.next(releaseMap);
      });
    });

    this._connection.on('lockHeartbeat', () => {
      // Heartbeat acknowledged — no state change needed.
    });

    this._connection.on('error', (message: string) => {
      console.error('[LockService] Hub error:', message);
    });
  }

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

  ngOnDestroy(): void {
    this._destroyed$.next();
    this._destroyed$.complete();
    this._stopHeartbeat();
    this._stopInactivityTimer();
    this._connection?.stop();
  }

  private _setupActivityListeners(): void {
    const resetInactivityTimer = () => {
      this._lastActivityTime = Date.now();
      this._resetInactivityTimer();
    };

    document.addEventListener('keydown', resetInactivityTimer);
    document.addEventListener('mousemove', resetInactivityTimer);
    document.addEventListener('click', resetInactivityTimer);
    document.addEventListener('touchstart', resetInactivityTimer);
  }

  private _resetInactivityTimer(): void {
    if (this._inactivityTimer !== null) {
      clearTimeout(this._inactivityTimer);
    }

    if (this._lockState$.value.status === 'owned') {
      this._inactivityTimer = setTimeout(async () => {
        console.warn('[LockService] User inactive. Auto-releasing lock.');
        await this.releaseLock(this._currentRecordId!);
      }, INACTIVITY_TIMEOUT_MS);
    }
  }
}
