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

import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject } from 'rxjs';
import { RecordListItem } from '../models';

@Injectable({ providedIn: 'root' })
export class RecordsService {
  private readonly _records$ = new BehaviorSubject<RecordListItem[]>([]);
  private readonly _loading$ = new BehaviorSubject<boolean>(false);
  private readonly _error$ = new BehaviorSubject<string | null>(null);

  readonly records$ = this._records$.asObservable();

  get records(): RecordListItem[] {
    return this._records$.value;
  }

  get loading(): boolean {
    return this._loading$.value;
  }

  get error(): string | null {
    return this._error$.value;
  }

  constructor(private readonly http: HttpClient) {}

  /**
   * Fetch up to `limit` records from `GET /api/records?limit=N`.
   * Updates loading / error signals around the request.
   */
  async refresh(limit = 10): Promise<void> {
    this._loading$.next(true);
    this._error$.next(null);
    try {
      const items = await this.http.get<RecordListItem[]>(`/api/records?limit=${limit}`).toPromise();
      this._records$.next(items ?? []);
    } catch {
      this._error$.next('Failed to load records.');
    } finally {
      this._loading$.next(false);
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
    const updatedItems = this.records.map((item) =>
      item.id === recordId ? { ...item, ...patch } : item,
    );
    this._records$.next(updatedItems);
  }

  /**
   * Apply field edits to a record after a successful dialog save.
   * Stamps `updatedAt` with the current time so the table column reflects the edit.
   */
  updateRecord(recordId: string, changes: Partial<RecordListItem>): void {
    const updatedItems = this.records.map((item) =>
      item.id === recordId
        ? { ...item, ...changes, updatedAt: new Date().toISOString() }
        : item,
    );
    this._records$.next(updatedItems);
  }
}
