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

const HUB_URL = '/hubs/recordLock';
const HEARTBEAT_INTERVAL_MS = 30_000;
const INACTIVITY_TIMEOUT_MS = 300_000; // 1 minute

@Injectable({ providedIn: 'root' })
export class LockService implements OnDestroy {
  private _connection: signalR.HubConnection | null = null;
  private _lockState$ = new BehaviorSubject<LockState>({ status: 'unlocked' });
  private _destroyed$ = new Subject<void>();
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private _currentRecordId: string | null = null;
  private _lastActivityTime: number = Date.now();

  private _allLocks$ = new BehaviorSubject<Map<string, LockInfo>>(new Map());

  /** Observable of the current lock state for the active record. */
  readonly lockState$: Observable<LockState> = this._lockState$.asObservable();

  /** Observable of all active locks (recordId → LockInfo). Used by the list view. */
  readonly allLocks$: Observable<Map<string, LockInfo>> = this._allLocks$.asObservable();

  constructor(private http: HttpClient, private zone: NgZone, private auth: MockAuth) {}

  // ── Connection ──────────────────────────────────────────────────────────────

  private async ensureConnected(): Promise<void> {
    if (
      this._connection &&
      this._connection.state === signalR.HubConnectionState.Connected
    ) {
      return;
    }

    this._connection = new signalR.HubConnectionBuilder()
      .withUrl(HUB_URL)
      .withAutomaticReconnect()
      .configureLogging(signalR.LogLevel.Information)
      .build();

    this._registerHubHandlers();

    this._connection.onreconnected(async () => {
      console.log('[LockService] Reconnected.');
      // Re-assert lock and restart heartbeat if we had one
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
   * Bootstrap lock state from REST, then subscribe to the hub.
   * Call this when an edit view initialises.
   */
  async subscribeToRecord(recordId: string): Promise<void> {
    this._stopHeartbeat();
    this._stopInactivityTimer();

    this._currentRecordId = recordId;
    this._lockState$.next({ status: 'unlocked' });

    // Re-register hub handlers so the currentRecordId filter is up-to-date
    if (this._connection) {
      this._registerHubHandlers();
    }

    // Bootstrap current state via REST (handles page-refresh scenario)
    try {
      const existing = await firstValueFrom(
        this.http.get<LockInfo | null>(`/api/locks/${recordId}`, {
          observe: 'body',
        }),
      ).catch(() => null);

      if (existing) {
        this._lockState$.next({ status: 'locked-by-other', lock: existing });
      }
    } catch {
      // Non-critical — hub events will correct state
    }

    await this.ensureConnected();
  }

  /** Subscribe to lock changes for all records. Used by the list view. */
  async subscribeToAllLocks(): Promise<void> {
    await this.ensureConnected();
    await this._connection!.invoke('SubscribeToAllLocks');

    try {
      const locks = await firstValueFrom(
        this.http.get<LockInfo[]>('/api/locks'),
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
    await this.ensureConnected();
    await this._connection!.invoke('AcquireLock', recordId, userId, displayName);
    // Start inactivity monitoring when lock acquired
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
    await this.ensureConnected();
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

    // Remove stale handlers before re-registering (safe on fresh connections too)
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
        // Update global locks map
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
        // Update global locks map (someone else holds it)
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
        // Update global locks map
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

  /** Track user activity (keyboard, mouse, etc.) */
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

    // Only set timer if we currently own the lock
    if (this._lockState$.value.status === 'owned') {
      this._inactivityTimer = setTimeout(async () => {
        console.warn(
          '[LockService] User inactive for 5 minutes. Auto-releasing lock.'
        );
        await this.releaseLock(this._currentRecordId!);
        // Optionally notify user
      }, INACTIVITY_TIMEOUT_MS);
    }
  }
}

