// ─────────────────────────────────────────────────────────────────
// models/index.ts
//
// Central barrel for all domain interfaces and types.
// Import from this file in the rest of the app:
//   import { LockInfo, LockState, RecordListItem } from '../models';
// ─────────────────────────────────────────────────────────────────

// ── Lock state ────────────────────────────────────────────────────

/** Full lock metadata returned by the backend hub / REST endpoint. */
export interface LockInfo {
  recordId: string;
  lockedByUserId: string;
  lockedByDisplayName: string;
  acquiredAtUtc: string;
  expiresAtUtc: string;
  connectionId: string;
}

/**
 * Discriminated union representing the three possible lock states
 * for the currently-open record:
 * - `unlocked`        – no active lock
 * - `owned`           – locked by the current user
 * - `locked-by-other` – locked by someone else
 */
export type LockState =
  | { status: 'unlocked' }
  | { status: 'owned'; lock: LockInfo }
  | { status: 'locked-by-other'; lock: LockInfo };

/** Payload emitted when another user requests an access transfer. */
export interface LockTransferInfo {
  recordId: string;
  requestingUserId: string;
  requestingDisplayName: string;
}

// ── Records list ──────────────────────────────────────────────────

/**
 * A single row in the records list table.
 * Mirrors the `RecordListItem` C# DTO from `RecordsController`.
 */
export interface RecordListItem {
  id: string;
  name: string;
  /** Domain status string, e.g. "active" | "draft" | "archived". */
  status: string;
  updatedAt: string;
  /** True when any user currently holds the lock for this record. */
  isLocked: boolean;
  /** Display name of the lock holder, if locked. */
  lockedByDisplayName?: string;
  /** ISO-8601 UTC timestamp when the lock was acquired, if locked. */
  lockedAtUtc?: string;
}
