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
 *   │  <app-record-dialog>  (rendered only when open)     │
 *   └─────────────────────────────────────────────────────┘
 *
 * Flow when a user clicks a row:
 *   1. `onOpenRecord` is called.
 *   2. Stale banner is cleared immediately.
 *   3. If the record is already locked by someone else → show banner, stop.
 *   4. Optimistic pending indicator shown on the row.
 *   5. `LockService.acquireLock()` negotiates with the SignalR hub.
 *   6a. Acquired → open the dialog, start heartbeat.
 *   6b. Rejected → show "X is editing" banner.
 *
 * When the dialog closes:
 *   `RecordDialogComponent` releases the lock internally; `onDialogClosed`
 *   clears `selectedRecord` and shows a banner if the release failed.
 */

import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { MockAuth } from './services/mock-auth';
import { LockService } from './services/lock';
import { RecordDialogCloseEvent } from './components/record-dialog/record-dialog.component';
import { RecordsService } from './services/records.service';
import { RecordListItem } from './models';

const BANNER_DURATION_MS = 3000;

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrls: ['./app.css'],
})
export class App implements OnInit, OnDestroy {
  /** The record whose dialog is currently open (null = no dialog). */
  selectedRecord: RecordListItem | null = null;
  /** The record ID currently being acquired; disables double-click on that row. */
  pendingAcquireRecordId: string | null = null;
  /** Transient toast message shown to the user (auto-clears after BANNER_DURATION_MS). */
  bannerMessage = '';

  private _bannerTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly _destroy$ = new Subject<void>();

  /** Reflects SignalR reconnect status — passed down to the dialog for the warning banner. */
  connectionLost = false;

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
      .subscribe((lost) => {
        this.connectionLost = lost;
      });

    this.recordsService.records$
      .pipe(takeUntil(this._destroy$))
      .subscribe((items) => {
        const ids = items.map((r) => r.id);
        if (ids.length > 0) {
          void this.lockService.subscribeToRecords(ids);
        }
      });

    // Kick off the initial data load as soon as the component is ready
    void this.recordsService.refresh(10);
  }

  ngOnDestroy(): void {
    this._destroy$.next();
    this._destroy$.complete();
    this._clearBanner();
  }

  /**
   * Called when the user clicks a row in the records list.
   * Acquires the lock and opens the dialog if successful.
   */
  async onOpenRecord(record: RecordListItem): Promise<void> {
    // Ignore rapid double-clicks while an acquire is already in flight
    if (this.pendingAcquireRecordId === record.id) return;

    // Always clear any stale "X is editing" banner before starting a new action
    this._clearBanner();

    // Fast-path: if the record's cached state shows it's locked by someone else,
    // skip the hub round-trip and show the banner immediately.
    if (record.isLocked && record.lockedByDisplayName !== this.auth.currentUser.displayName) {
      this._showBanner(`${record.lockedByDisplayName ?? 'Someone'} is editing this record`);
      return;
    }

    this.pendingAcquireRecordId = record.id;
    try {
      const result = await this.lockService.acquireLock(record.id);

      if (!result.acquired) {
        // Hub rejected the lock — someone else sneaked in between the cache check and now
        this._showBanner(`${result.lock?.lockedByDisplayName ?? 'Someone'} is editing this record`);
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

  /**
   * Called by `RecordDialogComponent` when the user saves or cancels.
   * The dialog releases the lock internally; we just clean up the shell state here.
   */
  onDialogClosed(event: RecordDialogCloseEvent): void {
    if (event.releaseFailed) {
      this._showBanner('Release lock failed, retry queued in background.');
    }
    this.selectedRecord = null;
  }

  // ── Banner helpers ───────────────────────────────────────────────

  private _showBanner(message: string): void {
    this._clearBanner();
    this.bannerMessage = message;
    this._bannerTimeout = setTimeout(() => {
      if (this.bannerMessage === message) this.bannerMessage = '';
      this._bannerTimeout = null;
    }, BANNER_DURATION_MS);
  }


  private _clearBanner(): void {
    this.bannerMessage = '';

    if (this._bannerTimeout !== null) {
      clearTimeout(this._bannerTimeout);
      this._bannerTimeout = null;
    }
  }
}
