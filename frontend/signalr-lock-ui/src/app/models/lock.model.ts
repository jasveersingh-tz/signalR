export interface LockInfo {
  recordId: string;
  lockedByUserId: string;
  lockedByDisplayName: string;
  acquiredAtUtc: string;
  expiresAtUtc: string;
  connectionId: string;
}

export type LockState =
  | { status: 'unlocked' }
  | { status: 'owned'; lock: LockInfo }
  | { status: 'locked-by-other'; lock: LockInfo };
