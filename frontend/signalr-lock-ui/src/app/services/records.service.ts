/**
 * RecordsService — signal-based records list state.
 *
 * Holds the list of records as Angular Signals so any component that reads
 * `records()` automatically re-renders when the data changes, with no manual
 * change-detection calls needed.
 *
 * Key operations:
 *  - `refresh(limit)`  – fetches fresh data from the backend and updates signals.
 *  - `patchLock()`     – optimistically updates a single row's lock fields when a
 *                        hub event arrives, before the next REST refresh completes.
 *  - `updateRecord()`  – applies local field edits after a successful dialog save.
 */

import { Injectable, computed, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { RecordListItem } from '../models';

@Injectable({ providedIn: 'root' })
export class RecordsService {
  // ── Private signals (writable) ────────────────────────────────────
  private readonly _records = signal<RecordListItem[]>([]);
  private readonly _loading = signal(false);
  private readonly _error   = signal<string | null>(null);

  // ── Public read-only projections ──────────────────────────────────
  /** Current list of records. Reactive — components auto-update on change. */
  readonly records = computed(() => this._records());
  /** True while a refresh HTTP request is in flight. */
  readonly loading = computed(() => this._loading());
  /** Non-null when the last refresh failed; contains a user-friendly message. */
  readonly error   = computed(() => this._error());

  constructor(private readonly http: HttpClient) {}

  /**
   * Fetch up to `limit` records from `GET /api/records?limit=N`.
   * Updates loading / error signals around the request.
   */
  async refresh(limit = 10): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    try {
      const items = await firstValueFrom(
        this.http.get<RecordListItem[]>(`/api/records?limit=${limit}`),
      );
      this._records.set(items);
    } catch {
      this._error.set('Failed to load records.');
    } finally {
      this._loading.set(false);
    }
  }

  /**
   * Optimistically update a single row's lock fields.
   * Called immediately when a hub `lockAcquired` / `lockReleased` event arrives
   * so the lock icon updates before the debounced REST refresh fires.
   */
  patchLock(
    recordId: string,
    patch: Pick<RecordListItem, 'isLocked' | 'lockedByDisplayName' | 'lockedAtUtc'>,
  ): void {
    this._records.update((items) =>
      items.map((item) => (item.id === recordId ? { ...item, ...patch } : item)),
    );
  }

  /**
   * Apply field edits to a record after a successful dialog save.
   * Stamps `updatedAt` with the current time so the table column reflects the edit.
   */
  updateRecord(recordId: string, changes: Partial<RecordListItem>): void {
    this._records.update((items) =>
      items.map((item) =>
        item.id === recordId
          ? { ...item, ...changes, updatedAt: new Date().toISOString() }
          : item,
      ),
    );
  }
}
