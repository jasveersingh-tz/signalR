/**
 * App — root component / application shell.
 *
 * Layout:
 *   ┌─ header bar ────────────────────────────────────────┐
 *   │  Title                        Logged in as: <name>  │
 *   └─────────────────────────────────────────────────────┘
 *   ┌─ main ──────────────────────────────────────────────┐
 *   │  [banner message, if any]                           │
 *   │  <app-records-list>                                 │
 *   │  <app-record-dialog>  (edit mode, when open)        │
 *   │  <app-record-dialog>  (view-only, when locked)      │
 *   └─────────────────────────────────────────────────────┘
 *
 * Flow when a user clicks a row:
 *   1. `onOpenRecord` is called.
 *   2. Stale banner is cleared immediately.
 *   3a. Record is locked by someone else → open dialog in view-only mode.
 *   3b. Record is free → `LockService.acquireLock()` negotiates with the hub.
 *      • Acquired → open dialog in edit mode, start heartbeat.
 *      • Rejected → someone sneaked in; open dialog in view-only mode.
 *
 * When the dialog closes:
 *   `RecordDialogComponent` releases the lock internally; `onDialogClosed`
 *   clears `selectedRecord` / `viewOnlyRecord` and shows a banner on failure.
 */

import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { MockAuth } from './services/mock-auth';
import { LockService } from './services/lock';
import { PageBannerEvent, RecordDialogCloseEvent } from './components/record-dialog/record-dialog.component';
import { RecordsService } from './services/records.service';
import { RecordListItem } from './models';

const BANNER_DURATION_MS = 3000;
const ACCESS_REQUEST_TIMEOUT_MS = 65_000;
const ACCESS_REQUEST_POLL_MS = 1500;

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrls: ['./app.css'],
})
export class App implements OnInit, OnDestroy {
  /** The record currently open in EDIT mode (null = no edit dialog). */
  selectedRecord: RecordListItem | null = null;
  /**
   * The record currently open in VIEW-ONLY mode — user does not hold the lock.
   * Shown alongside the "Acquire Lock" / transfer flow UI.
   */
  viewOnlyRecord: RecordListItem | null = null;
  /** The record ID currently being acquired; blocks double-click on that row. */
  pendingAcquireRecordId: string | null = null;
  bannerMessage = '';
  bannerTone: 'info' | 'warn' | 'error' | 'success' = 'warn';
  private _lockRequestPendingRecordId: string | null = null;
  private _lockRequestCooldownUntilMs = 0;
  private _cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private _requestTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private _requestPollTimer: ReturnType<typeof setInterval> | null = null;
  private _autoAcquireInFlight = false;

  private _bannerTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly _destroy$ = new Subject<void>();

  connectionLost = false;

  get activeRecord(): RecordListItem | null {
    return this.selectedRecord ?? this.viewOnlyRecord;
  }

  get activeRecordViewOnly(): boolean {
    return this.viewOnlyRecord !== null && this.selectedRecord === null;
  }

  get canAcquireFromToolbar(): boolean {
    if (!this.viewOnlyRecord) return false;
    if (this.pendingAcquireRecordId !== null) return false;
    if (this._lockRequestPendingRecordId === this.viewOnlyRecord.id) return false;
    if (Date.now() < this._lockRequestCooldownUntilMs) return false;
    return true;
  }

  get records(): RecordListItem[] { return this.recordsService.records; }
  get loading(): boolean           { return this.recordsService.loading; }
  get error(): string | null       { return this.recordsService.error; }

  constructor(
    public readonly auth: MockAuth,
    private readonly lockService: LockService,
    private readonly recordsService: RecordsService,
  ) {}

  ngOnInit(): void {
    this.lockService.connectionLost$
      .pipe(takeUntil(this._destroy$))
      .subscribe((lost) => { this.connectionLost = lost; });

    this.recordsService.records$
      .pipe(takeUntil(this._destroy$))
      .subscribe((items) => {
        const ids = items.map((r) => r.id);
        if (ids.length > 0) void this.lockService.subscribeToRecords(ids);

        // Fallback: if the holder released but approval event was missed, auto-acquire.
        if (!this.viewOnlyRecord || this._lockRequestPendingRecordId !== this.viewOnlyRecord.id) return;

        const latest = items.find((r) => r.id === this.viewOnlyRecord!.id);
        if (!latest) return;

        this.viewOnlyRecord = latest;
        if (!latest.isLocked) void this._tryAcquirePendingRequest('released');
      });

    this.lockService.lockTransferApproved$
      .pipe(takeUntil(this._destroy$))
      .subscribe((recordId) => void this._onTransferApproved(recordId));

    this.lockService.lockTransferRejected$
      .pipe(takeUntil(this._destroy$))
      .subscribe((recordId) => this._onTransferRejected(recordId));

    this.lockService.lockTransferCooldown$
      .pipe(takeUntil(this._destroy$))
      .subscribe((e) => this._onTransferCooldown(e.recordId, e.remainingSeconds));

    this.lockService.lockTransferExpired$
      .pipe(takeUntil(this._destroy$))
      .subscribe((recordId) => void this._onTransferExpired(recordId));

    void this.recordsService.refresh(10);
  }

  ngOnDestroy(): void {
    this._destroy$.next();
    this._destroy$.complete();
    this._clearBanner();
    if (this._cooldownTimer !== null) clearTimeout(this._cooldownTimer);
    if (this._requestTimeoutTimer !== null) clearTimeout(this._requestTimeoutTimer);
    if (this._requestPollTimer !== null) clearInterval(this._requestPollTimer);
  }

  async onOpenRecord(record: RecordListItem): Promise<void> {
    if (this.pendingAcquireRecordId === record.id) return;
    this._clearBanner();

    // Keep edit mode intact when clicking the currently edited record.
    if (this.selectedRecord?.id === record.id) return;

    // Refresh view-only details when clicking the same locked row again.
    if (this.viewOnlyRecord?.id === record.id) {
      this.viewOnlyRecord = record;
      return;
    }

    await this._resetPanelStateForSelectionChange();

    // Fast-path: record is locked by someone else → open view-only mode immediately
    if (record.isLocked && record.lockedByDisplayName !== this.auth.currentUser.displayName) {
      this.selectedRecord = null;
      this.viewOnlyRecord = record;
      this._showLockedRecordBanner(record);
      return;
    }

    // Close any open view-only dialog when trying to edit
    this.viewOnlyRecord = null;

    this.pendingAcquireRecordId = record.id;
    try {
      const result = await this.lockService.acquireLock(record.id);

      if (!result.acquired) {
        // Someone else grabbed the lock between the cache check and the hub roundtrip
        this.viewOnlyRecord = result.lock
          ? { ...record, isLocked: true, lockedByDisplayName: result.lock.lockedByDisplayName }
          : record;
        this._showLockedRecordBanner(this.viewOnlyRecord);
        return;
      }

      // Lock granted — open the editor dialog
      this.lockService.startHeartbeat(record.id);
      this.selectedRecord = {
        ...record,
        isLocked: true,
        lockedByDisplayName: this.auth.currentUser.displayName,
      };
    } finally {
      this.pendingAcquireRecordId = null;
    }
  }

  onDialogClosed(event: RecordDialogCloseEvent): void {
    if (event.releaseFailed) {
      this._showBanner('Release lock failed, retry queued in background.', 'warn');
    }
    this.selectedRecord = null;
  }

  async onAcquireFromToolbar(): Promise<void> {
    if (!this.viewOnlyRecord || !this.canAcquireFromToolbar) return;
    this._lockRequestPendingRecordId = this.viewOnlyRecord.id;
    this._showBanner('Access request sent. Waiting for lock holder response.', 'info', true);
    this._startRequestTimeout(this.viewOnlyRecord.id);
    this._startRequestPoll(this.viewOnlyRecord.id);
    try {
      await this.lockService.requestLockTransfer(this.viewOnlyRecord.id);
    } catch {
      this._lockRequestPendingRecordId = null;
      this._clearRequestTimeout();
      this._clearRequestPoll();
      this._showLockedRecordBanner(this.viewOnlyRecord);
    }
  }

  onPanelBanner(event: PageBannerEvent): void {
    this._showBanner(event.message, event.tone ?? 'info');
  }

  private async _resetPanelStateForSelectionChange(): Promise<void> {
    const previousEditRecord = this.selectedRecord;

    this.selectedRecord = null;
    this.viewOnlyRecord = null;
    this._resetAccessRequestState();

    if (!previousEditRecord) return;

    const released = await this.lockService.releaseLockWithRetry(previousEditRecord.id);
    if (!released) {
      this._showBanner('Release lock failed, retry queued in background.', 'warn');
    }
  }

  private _showLockedRecordBanner(record: RecordListItem): void {
    const displayName = record.lockedByDisplayName ?? 'Another user';
    this._showBanner(`${displayName} is editing this record, do you want to access this record?`, 'info', true);
  }

  private _resetAccessRequestState(): void {
    this._lockRequestPendingRecordId = null;
    this._autoAcquireInFlight = false;
    this._lockRequestCooldownUntilMs = 0;
    if (this._cooldownTimer !== null) {
      clearTimeout(this._cooldownTimer);
      this._cooldownTimer = null;
    }
    this._clearRequestTimeout();
    this._clearRequestPoll();
  }

  private async _onTransferApproved(recordId: string): Promise<void> {
    if (!this.viewOnlyRecord || this.viewOnlyRecord.id !== recordId) return;
    this._clearRequestTimeout();
    await this._tryAcquirePendingRequest('approved');
  }

  private _onTransferRejected(recordId: string): void {
    if (!this.viewOnlyRecord || this.viewOnlyRecord.id !== recordId) return;
    this._lockRequestPendingRecordId = null;
    this._clearRequestTimeout();
    this._showBanner('Access request was denied.', 'error');
  }

  private _onTransferCooldown(recordId: string, remainingSeconds: number): void {
    if (!this.viewOnlyRecord || this.viewOnlyRecord.id !== recordId) return;
    this._lockRequestPendingRecordId = null;
    this._clearRequestTimeout();
    this._lockRequestCooldownUntilMs = Date.now() + (remainingSeconds * 1000);
    this._showBanner(
      `Access request was denied recently. Try again in ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}.`,
      'warn',
      true,
    );

    if (this._cooldownTimer !== null) clearTimeout(this._cooldownTimer);
    this._cooldownTimer = setTimeout(() => {
      this._lockRequestCooldownUntilMs = 0;
      this._cooldownTimer = null;
      if (this.viewOnlyRecord) this._showLockedRecordBanner(this.viewOnlyRecord);
    }, remainingSeconds * 1000);
  }

  private async _onTransferExpired(recordId: string): Promise<void> {
    if (!this.viewOnlyRecord || this.viewOnlyRecord.id !== recordId) return;
    this._clearRequestTimeout();
    await this._tryAcquirePendingRequest('expired');
  }

  private _startRequestTimeout(recordId: string): void {
    this._clearRequestTimeout();
    this._requestTimeoutTimer = setTimeout(() => {
      if (this._lockRequestPendingRecordId !== recordId) return;
      this._lockRequestPendingRecordId = null;
      if (this.viewOnlyRecord?.id === recordId) {
        this._showBanner('No response yet. You can try Acquire Lock again.', 'warn', true);
      }
    }, ACCESS_REQUEST_TIMEOUT_MS);
  }

  private _clearRequestTimeout(): void {
    if (this._requestTimeoutTimer !== null) {
      clearTimeout(this._requestTimeoutTimer);
      this._requestTimeoutTimer = null;
    }
  }

  private _startRequestPoll(recordId: string): void {
    this._clearRequestPoll();
    this._requestPollTimer = setInterval(() => {
      void this._pollPendingRequest(recordId);
    }, ACCESS_REQUEST_POLL_MS);
  }

  private _clearRequestPoll(): void {
    if (this._requestPollTimer !== null) {
      clearInterval(this._requestPollTimer);
      this._requestPollTimer = null;
    }
  }

  private async _pollPendingRequest(recordId: string): Promise<void> {
    if (this._lockRequestPendingRecordId !== recordId) {
      this._clearRequestPoll();
      return;
    }
    if (!this.viewOnlyRecord || this.viewOnlyRecord.id !== recordId) {
      this._clearRequestPoll();
      return;
    }

    const lock = await this.lockService.getLockInfo(recordId);
    if (!lock) {
      await this._tryAcquirePendingRequest('released');
      return;
    }

    // If ownership already moved (same user from another connection), try to acquire again to bind this session.
    if (lock.lockedByUserId === this.auth.currentUser.userId) {
      await this._tryAcquirePendingRequest('approved');
      return;
    }

    this.viewOnlyRecord = {
      ...this.viewOnlyRecord,
      isLocked: true,
      lockedByDisplayName: lock.lockedByDisplayName,
      lockedAtUtc: lock.acquiredAtUtc,
    };
  }

  private async _tryAcquirePendingRequest(trigger: 'approved' | 'expired' | 'released'): Promise<void> {
    if (!this.viewOnlyRecord) return;
    if (this._autoAcquireInFlight) return;

    this._autoAcquireInFlight = true;
    try {
      const recordId = this.viewOnlyRecord.id;
      const result = await this.lockService.acquireLock(recordId);
      if (!result.acquired) {
        this._lockRequestPendingRecordId = null;
        this._showLockedRecordBanner(this.viewOnlyRecord);
        return;
      }

      this._lockRequestPendingRecordId = null;
      this.lockService.startHeartbeat(recordId);
      this.selectedRecord = {
        ...this.viewOnlyRecord,
        isLocked: true,
        lockedByDisplayName: this.auth.currentUser.displayName,
      };
      this.viewOnlyRecord = null;

      const successMessage = trigger === 'released'
        ? 'Lock became available and was acquired.'
        : 'Lock transferred. You can now edit this record.';
      this._showBanner(successMessage, 'success');
    } finally {
      this._autoAcquireInFlight = false;
    }
  }

  // ── Banner helpers ───────────────────────────────────────────────

  private _showBanner(
    message: string,
    tone: 'info' | 'warn' | 'error' | 'success' = 'warn',
    sticky = false,
  ): void {
    this._clearBanner();
    this.bannerMessage = message;
    this.bannerTone = tone;

    if (!sticky) {
      this._bannerTimeout = setTimeout(() => {
        if (this.bannerMessage === message) this.bannerMessage = '';
        this._bannerTimeout = null;
      }, BANNER_DURATION_MS);
    }
  }

  private _clearBanner(): void {
    this.bannerMessage = '';
    if (this._bannerTimeout !== null) {
      clearTimeout(this._bannerTimeout);
      this._bannerTimeout = null;
    }
  }
}
