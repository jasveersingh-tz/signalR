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
   * Return mock sample records, merged with actual lock state from backend.
   * This ensures lock icons are in sync with the server immediately.
   */
  async refresh(limit = 10): Promise<void> {
    this._loading$.next(true);
    this._error$.next(null);
    try {
      // Create mock records (all initially unlocked)
      const mockRecords = Array.from({ length: Math.min(limit, 20) }, (_, i) => ({
        id: `REC-${String(i + 1).padStart(3, '0')}`,
        name: `Sample Record ${i + 1}`,
        status: i % 3 === 0 ? 'archived' : i % 2 === 0 ? 'draft' : 'active',
        updatedAt: new Date(Date.now() - (i + 1) * 5 * 60 * 1000).toISOString(),
        isLocked: false,
        lockedByDisplayName: undefined as string | undefined,
        lockedAtUtc: undefined as string | undefined,
      }));

      // Fetch current lock state from backend (only update records that have locks)
      try {
        const lockList = await this.http.get<any[]>('/api/locks').toPromise();
        
        if (Array.isArray(lockList) && lockList.length > 0) {
          // Create a map of recordId → lock for quick lookup
          const locksMap = new Map(lockList.map(lock => [lock.recordId, lock]));
          
          // Update only records that actually have locks
          const mergedRecords = mockRecords.map(record => {
            const lock = locksMap.get(record.id);
            if (lock && lock.recordId) {
              // Only apply lock if we have a valid lock object with recordId
              return {
                ...record,
                isLocked: true,
                lockedByDisplayName: lock.lockedByDisplayName || undefined,
                lockedAtUtc: lock.acquiredAtUtc || undefined,
              };
            }
            return record; // Keep unlocked
          });
          
          this._records$.next(mergedRecords);
        } else {
          // No locks returned, all records are unlocked
          this._records$.next(mockRecords);
        }
      } catch (err) {
        // Lock endpoint may fail or not exist, use all unlocked records
        console.debug('Could not fetch locks, starting with all records unlocked:', err);
        this._records$.next(mockRecords);
      }
    } catch (err) {
      this._error$.next('Failed to load records.');
      console.error('RecordsService.refresh error:', err);
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
