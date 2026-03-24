/**
 * RecordDialogComponent — modal editor shown when a user holds a lock, or a
 * read-only viewer with an "Request Access" button when the record is locked by
 * someone else (viewOnly mode).
 *
 * Lock-release paths for EDIT mode (all roads lead to `_closeWithRelease`):
 *  1. User clicks Save    → optimistic record update + release.
 *  2. User clicks Cancel  → release only.
 *  3. ESC keypress        → same as Cancel.
 *  4. Backdrop click      → same as Cancel.
 *  5. Router navigation   → same as Cancel (NavigationStart subscription).
 *  6. Component destroyed → release if `_closing` flag is not yet set.
 *
 * Additional modals rendered inside the card:
 *  • Inactivity modal   — after 30 min idle: "Extend Session" or "Close Session".
 *  • Transfer request   — holder sees "User X wants access": Approve / Reject.
 *  • Session timeout    — existing lock-lost prompt (connection drop / takeover).
 */

import {
  Component,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
} from '@angular/core';
import { FormBuilder } from '@angular/forms';
import { Router, NavigationStart } from '@angular/router';
import { Subject } from 'rxjs';
import { debounceTime, filter, takeUntil } from 'rxjs/operators';
import { LockState, RecordListItem } from '../../models';
import { LockService } from '../../services/lock';
import { RecordsService } from '../../services/records.service';

export interface RecordDialogCloseEvent {
  saved: boolean;
  releaseFailed: boolean;
}

export interface PageBannerEvent {
  message: string;
  tone?: 'info' | 'warn' | 'error' | 'success';
}

const MODAL_AUTO_RELEASE_MS = 5_000;          // 5 sec of modal inactivity → auto-release (for testing)
const TRANSFER_AUTO_REJECT_MS = 60_000;      // 60 s then auto-reject if holder ignores

const SESSION_TIMEOUT_MESSAGES = {
  inactivity: 'Your session timed out due to inactivity. Please reopen the record to continue.',
  connection: 'Your session timed out because the connection was lost. Please reopen the record.',
  lockTaken:  'Your session timed out because this record is now locked by another user.',
} as const;

@Component({
  selector: 'app-record-dialog',
  templateUrl: './record-dialog.component.html',
  styleUrls: ['./record-dialog.component.css'],
})
export class RecordDialogComponent implements OnInit, OnChanges, OnDestroy {
  @Input() record!: RecordListItem;
  @Input() connectionLost = false;
  /**
   * When true the dialog opens in read-only mode — the current user does NOT hold
   * the lock.  They can click "Request Access" to ask the holder to transfer it.
   */
  @Input() viewOnly = false;

  @Output() closed = new EventEmitter<RecordDialogCloseEvent>();
  @Output() banner = new EventEmitter<PageBannerEvent>();

  private readonly _destroy$ = new Subject<void>();
  private _closing = false;
  private _hadOwnedLock = false;
  private _editModeInitialized = false;
  /** Set to true when view-only mode successfully acquires the lock after an approval. */
  private _lockAcquiredFromViewOnly = false;

  // ── Form ─────────────────────────────────────────────────────────
  readonly form: ReturnType<FormBuilder['group']>;

  // ── UI state flags ────────────────────────────────────────────────

  /** Blocking prompt: lock taken / connection lost / inactivity timeout. */
  showSessionTimeoutPrompt = false;
  sessionTimeoutMessage = '';

  /** 30-min inactivity warning modal (while in edit mode). */
  showInactivityModal = false;
  private _modalAutoReleaseTimer: ReturnType<typeof setTimeout> | null = null;

  /** Transfer request modal (shown to the LOCK HOLDER when someone wants access). */
  showTransferRequestModal = false;
  transferRequesterName = '';
  transferRequesterUserId = '';
  private _transferAutoRejectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Status shown in view-only mode while waiting for holder's response. */
  viewOnlyStatus: 'idle' | 'pending' | 'rejected' | 'cooldown' = 'idle';
  cooldownRemainingSeconds = 0;
  private _transferRequesterConnectionId = '';

  constructor(
    private readonly _fb: FormBuilder,
    private readonly _router: Router,
    private readonly _lockService: LockService,
    private readonly _recordsService: RecordsService,
  ) {
    this.form = this._fb.group({ name: [''], status: [''] });
  }

  ngOnInit(): void {
    this.form.patchValue({ name: this.record.name, status: this.record.status }, { emitEvent: false });

    if (this.viewOnly && this.record.lockedByDisplayName) {
      this._emitBanner(
        `Record locked by ${this.record.lockedByDisplayName}. You can request access.`,
        'info',
      );
    }

    if (!this.viewOnly) {
      this._initEditMode();
    } else {
      this._initViewOnlyMode();
    }

    // Release lock if user navigates away
    this._router.events
      .pipe(
        filter((event) => event instanceof NavigationStart),
        takeUntil(this._destroy$),
      )
      .subscribe(() => void this.cancel());
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['connectionLost']?.currentValue === true) {
      this._showSessionTimeoutPrompt(SESSION_TIMEOUT_MESSAGES.connection);
    }
  }

  ngOnDestroy(): void {
    this._destroy$.next();
    this._destroy$.complete();
    this._clearModalAutoReleaseTimer();
    this._clearTransferAutoRejectTimer();

    if (!this._closing) {
      // Only release if we actually hold the lock
      if (!this.viewOnly || this._lockAcquiredFromViewOnly) {
        void this._lockService.releaseLockWithRetry(this.record.id);
      }
    }
  }

  // ── Keyboard / backdrop ───────────────────────────────────────────

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.showSessionTimeoutPrompt)  { void this.acknowledgeSessionTimeout(); return; }
    if (this.showInactivityModal)       { void this.onExtendSession(); return; }
    if (this.showTransferRequestModal)  { void this.onRejectTransfer(); return; }
    void this.cancel();
  }

  onBackdropClick(event: MouseEvent): void {
    if (event.target !== event.currentTarget) return;
    if (this.showSessionTimeoutPrompt)  { void this.acknowledgeSessionTimeout(); return; }
    if (this.showInactivityModal)       { void this.onExtendSession(); return; }
    if (this.showTransferRequestModal)  { void this.onRejectTransfer(); return; }
    void this.cancel();
  }

  // ── Edit-mode actions ─────────────────────────────────────────────

  async save(): Promise<void> {
    if (this._closing) return;
    this._recordsService.updateRecord(this.record.id, {
      name:   this.form.value.name?.trim()   || this.record.name,
      status: this.form.value.status?.trim() || this.record.status,
    });
    await this._closeWithRelease(true);
  }

  async cancel(): Promise<void> {
    if (this._closing) return;
    await this._closeWithRelease(false);
  }

  async acknowledgeSessionTimeout(): Promise<void> {
    if (this._closing) return;
    await this._closeWithRelease(false);
  }

  // ── Inactivity modal actions ──────────────────────────────────────

  onExtendSession(): void {
    this.showInactivityModal = false;
    this._clearModalAutoReleaseTimer();
    this._lockService.extendSession(); // resets the 30-min countdown
  }

  onCloseSession(): void {
    this.showInactivityModal = false;
    this._clearModalAutoReleaseTimer();
    void this.cancel();
  }

  // ── Transfer request modal actions (lock HOLDER) ──────────────────

  async onApproveTransfer(): Promise<void> {
    this._clearTransferAutoRejectTimer();
    this.showTransferRequestModal = false;
    await this._lockService.approveLockTransfer(this.record.id, this.transferRequesterUserId, this.transferRequesterName, this._transferRequesterConnectionId);

    // After approval, the hub releases our lock server-side.
    // The `lockReleased` event will propagate through `lockState$` and trigger the
    // session-timeout prompt via `_onLockStateChanged`. We pre-empt that by closing cleanly.
    this._closing = true;
    this.closed.emit({ saved: false, releaseFailed: false });
  }

  async onRejectTransfer(): Promise<void> {
    this._clearTransferAutoRejectTimer();
    this.showTransferRequestModal = false;
    await this._lockService.rejectLockTransfer(this.record.id, this._transferRequesterConnectionId);
  }

  // ── View-only mode actions ────────────────────────────────────────

  async onRequestAccess(): Promise<void> {
    this.viewOnlyStatus = 'pending';
    this._emitBanner('Access request sent. Waiting for lock holder response.', 'info');
    await this._lockService.requestLockTransfer(this.record.id);
  }

  // ── Private: mode initialisation ─────────────────────────────────

  private _initEditMode(): void {
    if (this._editModeInitialized) return;
    this._editModeInitialized = true;

    this.form.valueChanges
      .pipe(debounceTime(150), takeUntil(this._destroy$))
      .subscribe((value) => {
        this._recordsService.updateRecord(this.record.id, {
          name: value.name?.trim() || this.record.name,
          status: value.status?.trim() || this.record.status,
        });
      });

    this._lockService.lockState$
      .pipe(takeUntil(this._destroy$))
      .subscribe((state) => this._onLockStateChanged(state));

    // 30-min inactivity warning
    this._lockService.inactivityWarning$
      .pipe(takeUntil(this._destroy$))
      .subscribe(() => this._showInactivityModal());

    // Incoming transfer request from another user
    this._lockService.lockTransferRequested$
      .pipe(
        filter((req) => req.recordId === this.record.id),
        takeUntil(this._destroy$),
      )
      .subscribe((req) => this._showTransferRequestModal(req.requestingUserId, req.requestingDisplayName, req.requesterConnectionId));
  }

  private _initViewOnlyMode(): void {
    this.form.disable();

    // Approved → try to acquire the lock and switch to edit mode
    this._lockService.lockTransferApproved$
      .pipe(
        filter((recordId) => recordId === this.record.id),
        takeUntil(this._destroy$),
      )
      .subscribe(() => void this._onTransferApproved());

    // Rejected → show rejection message
    this._lockService.lockTransferRejected$
      .pipe(
        filter((recordId) => recordId === this.record.id),
        takeUntil(this._destroy$),
      )
      .subscribe(() => {
        this.viewOnlyStatus = 'rejected';
        this._emitBanner('Access request was denied.', 'error');
      });

    // Cooldown (holder rejected recently)
    this._lockService.lockTransferCooldown$
      .pipe(
        filter((e) => e.recordId === this.record.id),
        takeUntil(this._destroy$),
      )
      .subscribe((e) => {
        this.viewOnlyStatus = 'cooldown';
        this.cooldownRemainingSeconds = e.remainingSeconds;
        this._emitBanner(
          `Access request is on cooldown. Try again in ${e.remainingSeconds} second${e.remainingSeconds === 1 ? '' : 's'}.`,
          'warn',
        );
      });

    // Lock expired just as user tried to request — they can now acquire directly
    this._lockService.lockTransferExpired$
      .pipe(
        filter((recordId) => recordId === this.record.id),
        takeUntil(this._destroy$),
      )
      .subscribe(() => void this._acquireAfterExpiry());
  }

  private async _onTransferApproved(): Promise<void> {
    this.viewOnlyStatus = 'idle';
    const result = await this._lockService.acquireLock(this.record.id);
    if (result.acquired) {
      this._lockAcquiredFromViewOnly = true;
      this.viewOnly = false; // switch to edit mode
      this.form.enable();
      this._lockService.startHeartbeat(this.record.id);
      this._initEditMode(); // wire up edit-mode subscriptions
      this._emitBanner('Lock transferred. You can now edit this record.', 'success');
    } else {
      // Lost the race — someone else grabbed it
      this.viewOnlyStatus = 'rejected';
      this._emitBanner('Could not acquire lock. Another user still holds it.', 'error');
    }
  }

  private async _acquireAfterExpiry(): Promise<void> {
    const result = await this._lockService.acquireLock(this.record.id);
    if (result.acquired) {
      this._lockAcquiredFromViewOnly = true;
      this.viewOnly = false;
      this.form.enable();
      this._lockService.startHeartbeat(this.record.id);
      this._initEditMode();
      this._emitBanner('Lock became available and was acquired.', 'success');
    } else {
      this.viewOnlyStatus = 'idle'; // lock taken by yet another user; reset
    }
  }

  // ── Private: modal helpers ────────────────────────────────────────

  private _showInactivityModal(): void {
    if (this._closing || this.showSessionTimeoutPrompt || this.showInactivityModal) return;
    this.showInactivityModal = true;
    // Auto-release if the user ignores the modal for 2.5 min
    this._modalAutoReleaseTimer = setTimeout(() => {
      this.showInactivityModal = false;
      void this.cancel();
    }, MODAL_AUTO_RELEASE_MS);
  }

  private _clearModalAutoReleaseTimer(): void {
    if (this._modalAutoReleaseTimer !== null) {
      clearTimeout(this._modalAutoReleaseTimer);
      this._modalAutoReleaseTimer = null;
    }
  }

  private _showTransferRequestModal(userId: string, displayName: string, connectionId: string): void {
    if (this._closing) return;
    this.transferRequesterUserId = userId;
    this.transferRequesterName = displayName;
    this._transferRequesterConnectionId = connectionId;
    this.showTransferRequestModal = true;
    // Auto-reject if holder ignores it for 60 seconds
    this._transferAutoRejectTimer = setTimeout(() => {
      void this.onRejectTransfer();
    }, TRANSFER_AUTO_REJECT_MS);
  }

  private _clearTransferAutoRejectTimer(): void {
    if (this._transferAutoRejectTimer !== null) {
      clearTimeout(this._transferAutoRejectTimer);
      this._transferAutoRejectTimer = null;
    }
  }

  private _showSessionTimeoutPrompt(message: string): void {
    if (this._closing || this.showSessionTimeoutPrompt) return;
    this.showInactivityModal = false;
    this._clearModalAutoReleaseTimer();
    this.showTransferRequestModal = false;
    this._clearTransferAutoRejectTimer();
    this.sessionTimeoutMessage = message;
    this.showSessionTimeoutPrompt = true;
    this.form.disable();
    this._emitBanner(message, 'warn');
  }

  private _onLockStateChanged(state: LockState): void {
    if (this._closing) return;

    if (state.status === 'owned') {
      this._hadOwnedLock = true;
      return;
    }

    if (!this._hadOwnedLock) return;

    // Dismiss inactivity modal if it's open — the lock is already gone
    this.showInactivityModal = false;
    this._clearModalAutoReleaseTimer();

    if (state.status === 'locked-by-other') {
      this._showSessionTimeoutPrompt(SESSION_TIMEOUT_MESSAGES.lockTaken);
      return;
    }

    this._showSessionTimeoutPrompt(SESSION_TIMEOUT_MESSAGES.inactivity);
  }

  private async _closeWithRelease(saved: boolean): Promise<void> {
    this._closing = true;
    this.showSessionTimeoutPrompt = false;
    this.showInactivityModal = false;
    this.showTransferRequestModal = false;
    this._clearModalAutoReleaseTimer();
    this._clearTransferAutoRejectTimer();

    // Only attempt release if we hold the lock
    if (!this.viewOnly || this._lockAcquiredFromViewOnly) {
      const released = await this._lockService.releaseLockWithRetry(this.record.id);
      if (!released) this._emitBanner('Could not release lock cleanly. It will expire automatically.', 'warn');
      this.closed.emit({ saved, releaseFailed: !released });
    } else {
      // View-only mode with no lock acquired — just close
      this.closed.emit({ saved: false, releaseFailed: false });
    }
  }

  private _emitBanner(message: string, tone: 'info' | 'warn' | 'error' | 'success' = 'info'): void {
    this.banner.emit({ message, tone });
  }
}
