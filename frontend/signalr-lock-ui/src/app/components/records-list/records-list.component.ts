/**
 * RecordsListComponent — renders a table of records with live lock-state indicators.
 *
 * Inputs:
 *  - `records`                 — array from RecordsService.records signal.
 *  - `loading`                 — shows a loading placeholder while fetching.
 *  - `error`                   — shows an error message if the fetch failed.
 *  - `pendingAcquireRecordId`  — disables the row while a lock acquire is in flight,
 *                                preventing accidental double-clicks.
 *
 * Output:
 *  - `openRecord` — emits the clicked RecordListItem to the parent shell.
 *
 * Lock icons:
 *  - Red  SVG lock (lock--locked)  → another user holds the lock.
 *  - Green SVG lock (lock--free)   → available to edit.
 */

import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { RecordListItem } from '../../models';

@Component({
  selector: 'app-records-list',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './records-list.component.html',
  styleUrl: './records-list.component.css',
})
export class RecordsListComponent {
  @Input({ required: true }) records: RecordListItem[] = [];
  @Input() loading = false;
  @Input() error: string | null = null;
  /** ID of the record currently being acquired; that row will be visually dimmed. */
  @Input() pendingAcquireRecordId: string | null = null;

  @Output() openRecord = new EventEmitter<RecordListItem>();

  /** Emit the clicked record unless an acquire for that row is already in flight. */
  onRowClick(record: RecordListItem): void {
    if (this.pendingAcquireRecordId === record.id) return;
    this.openRecord.emit(record);
  }

  /** CSS modifier class — drives red / green color via the stylesheet. */
  lockClass(record: RecordListItem): string {
    return record.isLocked ? 'lock--locked' : 'lock--free';
  }

  /** Accessible tooltip text shown on hover / focus. */
  lockTooltip(record: RecordListItem): string {
    return record.isLocked
      ? `Locked by ${record.lockedByDisplayName ?? 'another user'}`
      : 'Available to edit';
  }
}
