import { Injectable, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import * as signalR from '@microsoft/signalr';
import {
  BehaviorSubject,
  Observable,
  Subject,
  firstValueFrom,
} from 'rxjs';
import { LockInfo, LockState } from '../models/lock.model';

const HUB_URL = '/hubs/recordLock';
const HEARTBEAT_INTERVAL_MS = 30_000;

@Injectable({ providedIn: 'root' })
export class LockService implements OnDestroy {
  private _connection: signalR.HubConnection | null = null;
  private _lockState$ = new BehaviorSubject<LockState>({ status: 'unlocked' });
  private _destroyed$ = new Subject<void>();
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _currentRecordId: string | null = null;

  /** Observable of the current lock state for the active record. */
  readonly lockState$: Observable<LockState> = this._lockState$.asObservable();

  constructor(private http: HttpClient) {}

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
      // Re-assert lock if we had one
      if (this._lockState$.value.status === 'owned') {
        const state = this._lockState$.value;
        await this._connection!.invoke(
          'AcquireLock',
          state.lock.recordId,
          state.lock.lockedByUserId,
          state.lock.lockedByDisplayName,
        );
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
    // Stop heartbeat for any previously active record
    this._stopHeartbeat();

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

  /** Attempt to acquire the lock for the current record. */
  async acquireLock(
    recordId: string,
    userId: string,
    displayName: string,
  ): Promise<void> {
    await this.ensureConnected();
    await this._connection!.invoke('AcquireLock', recordId, userId, displayName);
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
      if (recordId === this._currentRecordId) {
        this._lockState$.next({ status: 'owned', lock });
      }
    });

    this._connection.on('lockRejected', (recordId: string, lock: LockInfo) => {
      if (recordId === this._currentRecordId) {
        this._lockState$.next({ status: 'locked-by-other', lock });
      }
    });

    this._connection.on('lockReleased', (recordId: string) => {
      if (recordId === this._currentRecordId) {
        this._lockState$.next({ status: 'unlocked' });
      }
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

  ngOnDestroy(): void {
    this._destroyed$.next();
    this._destroyed$.complete();
    this._stopHeartbeat();
    this._connection?.stop();
  }
}

