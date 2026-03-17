/**
 * RecordDialogComponent — modal editor shown when a user holds a lock.
 *
 * Lock-release paths (all roads lead to `_closeWithRelease`):
 *  1. User clicks Save    → optimistic record update + release.
 *  2. User clicks Cancel  → release only.
 *  3. ESC keypress        → same as Cancel.
 *  4. Backdrop click      → same as Cancel.
 *  5. Router navigation   → same as Cancel (NavigationStart subscription).
 *  6. Component destroyed → release if `_closing` flag is not yet set
 *                           (catches hard browser-back or programmatic destroy).
 *
 * The `_closing` flag prevents duplicate release calls when multiple
 * code paths converge (e.g. ESC fires while navigation is also in progress).
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
import { filter, takeUntil } from 'rxjs/operators';
import { LockState, RecordListItem } from '../../models';
import { LockService } from '../../services/lock';
import { RecordsService } from '../../services/records.service';

/** Emitted by `RecordDialogComponent.closed` on every close path. */
export interface RecordDialogCloseEvent {
  /** True if the user pressed Save; false for Cancel / ESC / backdrop. */
  saved: boolean;
  /** True if the lock could not be released after two attempts. */
  releaseFailed: boolean;
}

const SESSION_TIMEOUT_MESSAGES = {
  inactivity: 'Your session timed out due to inactivity. Please reopen the record to continue.',
  connection: 'Your session timed out because the connection was lost. Please reopen the record.',
  lockTaken: 'Your session timed out because this record is now locked by another user.',
} as const;

@Component({
  selector: 'app-record-dialog',
  templateUrl: './record-dialog.component.html',
  styleUrls: ['./record-dialog.component.css'],
})
export class RecordDialogComponent implements OnInit, OnChanges, OnDestroy {
  @Input() record!: RecordListItem;
  /** Passed from LockService.connectionLost$ — shows a reconnect warning in the modal. */
  @Input() connectionLost = false;

  @Output() closed = new EventEmitter<RecordDialogCloseEvent>();

  private readonly _destroy$ = new Subject<void>();
  /** Set to true as soon as a close path begins, preventing duplicate releases. */
  private _closing = false;
  /** Turns true once we have seen `owned`, so we can detect an owned → lost transition. */
  private _hadOwnedLock = false;

  readonly form: ReturnType<FormBuilder['group']>;
  /** Shown inside the modal when the lock could not be released cleanly. */
  releaseWarning = '';
  /** Controls the blocking timeout prompt shown inside the modal. */
  showSessionTimeoutPrompt = false;
  /** Human-friendly reason shown in the timeout prompt. */
  sessionTimeoutMessage = '';

  constructor(
    private readonly _fb: FormBuilder,
    private readonly _router: Router,
    private readonly _lockService: LockService,
    private readonly _recordsService: RecordsService,
  ) {
    this.form = this._fb.group({ name: [''], status: [''] });
  }

  ngOnInit(): void {
    // Pre-populate form fields with the current record values
    this.form.patchValue({ name: this.record.name, status: this.record.status });

    // Watch lock state transitions while modal is open.
    // If we lose ownership (unlocked or locked-by-other), show timeout prompt.
    this._lockService.lockState$
      .pipe(takeUntil(this._destroy$))
      .subscribe((state) => this._onLockStateChanged(state));

    // Release the lock automatically if the user navigates away
    this._router.events
      .pipe(
        filter((event) => event instanceof NavigationStart),
        takeUntil(this._destroy$),
      )
      .subscribe(() => void this.cancel());
  }

  ngOnChanges(changes: SimpleChanges): void {
    // If the socket disconnects while editing, require user acknowledgement and close.
    if (changes['connectionLost']?.currentValue === true) {
      this._showSessionTimeoutPrompt(SESSION_TIMEOUT_MESSAGES.connection);
    }
  }

  ngOnDestroy(): void {
    this._destroy$.next();
    this._destroy$.complete();

    // Safety net: release if the component is destroyed without going through a close path
    if (!this._closing) void this._lockService.releaseLockWithRetry(this.record.id);
  }

  /** Close via ESC key — same behaviour as Cancel. */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.showSessionTimeoutPrompt) {
      void this.acknowledgeSessionTimeout();
      return;
    }
    void this.cancel();
  }

  /** Close if the user clicks outside the dialog card. */
  onBackdropClick(event: MouseEvent): void {
    if (event.target !== event.currentTarget) return;
    if (this.showSessionTimeoutPrompt) {
      void this.acknowledgeSessionTimeout();
      return;
    }
    void this.cancel();
  }

  /** Acknowledge timeout prompt and close modal through the same safe release path. */
  async acknowledgeSessionTimeout(): Promise<void> {
    if (this._closing) return;
    await this._closeWithRelease(false);
  }

  /** Persist changes and release the lock. */
  async save(): Promise<void> {
    if (this._closing) return;
    // Apply edits optimistically so the list row updates immediately
    this._recordsService.updateRecord(this.record.id, {
      name:   this.form.value.name?.trim()   || this.record.name,
      status: this.form.value.status?.trim() || this.record.status,
    });
    await this._closeWithRelease(true);
  }

  /** Discard changes and release the lock. */
  async cancel(): Promise<void> {
    if (this._closing) return;
    await this._closeWithRelease(false);
  }

  private _onLockStateChanged(state: LockState): void {
    if (this._closing) return;

    if (state.status === 'owned') {
      this._hadOwnedLock = true;
      return;
    }

    if (!this._hadOwnedLock) {
      return;
    }

    if (state.status === 'locked-by-other') {
      this._showSessionTimeoutPrompt(SESSION_TIMEOUT_MESSAGES.lockTaken);
      return;
    }

    this._showSessionTimeoutPrompt(SESSION_TIMEOUT_MESSAGES.inactivity);
  }

  private _showSessionTimeoutPrompt(message: string): void {
    if (this._closing || this.showSessionTimeoutPrompt) {
      return;
    }

    this.sessionTimeoutMessage = message;
    this.showSessionTimeoutPrompt = true;
    this.form.disable();
  }

  /**
   * Common close path: attempt lock release (with one retry), then emit the
   * `closed` event regardless of whether release succeeded.
   */
  private async _closeWithRelease(saved: boolean): Promise<void> {
    this._closing = true;
    this.showSessionTimeoutPrompt = false;
    const released = await this._lockService.releaseLockWithRetry(this.record.id);
    if (!released) {
      // Lock will expire server-side via the inactivity timeout
      this.releaseWarning = 'Could not release lock cleanly. It will expire automatically.';
    }
    this.closed.emit({ saved, releaseFailed: !released });
  }
}
