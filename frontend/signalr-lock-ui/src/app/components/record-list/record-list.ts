import { ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { Subscription } from 'rxjs';
import { MockRecord } from '../../data/mock-records';
import { LockInfo } from '../../models/lock.model';
import { LockService } from '../../services/lock';
import { MockAuth } from '../../services/mock-auth';

@Component({
  selector: 'app-record-list',
  standalone: false,
  templateUrl: './record-list.html',
  styleUrl: './record-list.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecordList implements OnInit, OnDestroy {
  @Input() records: MockRecord[] = [];
  @Output() recordSelected = new EventEmitter<string>();

  allLocks = new Map<string, LockInfo>();
  selectedRecordId: string | null = null;

  private _sub?: Subscription;

  constructor(
    private lockService: LockService,
    private cdr: ChangeDetectorRef,
    public auth: MockAuth,
  ) {}

  async ngOnInit(): Promise<void> {
    this._sub = this.lockService.allLocks$.subscribe(locks => {
      this.allLocks = locks;
      this.cdr.markForCheck();
    });
    await this.lockService.subscribeToAllLocks("ARPO");
  }

  ngOnDestroy(): void {
    this._sub?.unsubscribe();
  }

  selectRecord(recordId: string): void {
    this.selectedRecordId = recordId;
    this.recordSelected.emit(recordId);
  }

  getLock(recordId: string): LockInfo | undefined {
    return this.allLocks.get(recordId);
  }

  isLockedByOther(recordId: string): boolean {
    const lock = this.allLocks.get(recordId);
    return !!lock && lock.lockedByUserId !== this.auth.currentUser.userId;
  }

  isLockedBySelf(recordId: string): boolean {
    const lock = this.allLocks.get(recordId);
    return !!lock && lock.lockedByUserId === this.auth.currentUser.userId;
  }
}
