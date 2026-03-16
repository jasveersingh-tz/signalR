export interface RecordListItem {
  id: string;
  name: string;
  status: string;
  updatedAt: string;
  isLocked: boolean;
  lockedByDisplayName?: string;
  lockedAtUtc?: string;
}
