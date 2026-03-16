import {
  Component,
  EventEmitter,
  Input,
  OnInit,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  HostListener,
} from '@angular/core';
import { FormBuilder, FormGroup } from '@angular/forms';
import { Subscription } from 'rxjs';
import { LockService } from '../../services/lock';
import { MockAuth } from '../../services/mock-auth';
import { LockState } from '../../models/lock.model';
import { MOCK_RECORDS } from '../../data/mock-records';

@Component({
  selector: 'app-record-editor',
  standalone: false,
  templateUrl: './record-editor.html',
  styleUrl: './record-editor.css',
})
export class RecordEditor implements OnInit, OnChanges, OnDestroy {
  @Input() recordId = 'demo-record-1';
  @Output() closed = new EventEmitter<void>();

  form: FormGroup;
  lockState: LockState = { status: 'unlocked' };
  statusMessage = '';
  isSaving = false;

  private _sub?: Subscription;

  constructor(
    private fb: FormBuilder,
    public lockService: LockService,
    public auth: MockAuth,
  ) {
    this.form = this.fb.group({
      title: [''],
      description: [''],
      status: ['active'],
    });
  }

  async ngOnInit(): Promise<void> {
    this._sub = this.lockService.lockState$.subscribe((state) => {
      this.lockState = state;
      this._syncFormState();
    });

    this._populateFormFromMockData();
    await this.lockService.subscribeToRecord(this.recordId);
    await this.openEdit();
  }

  async ngOnChanges(changes: SimpleChanges): Promise<void> {
    const change = changes['recordId'];
    // Skip the very first value — ngOnInit handles the initial subscription
    if (!change || change.isFirstChange()) return;

    const previousId: string = change.previousValue;

    // Release the lock on the previous record if we owned it
    if (this.lockState.status === 'owned' && previousId) {
      await this.lockService.releaseLock(previousId);
    }

    // Reset UI state for the new record
    this.statusMessage = '';
    this.isSaving = false;
    this._populateFormFromMockData();

    await this.lockService.subscribeToRecord(this.recordId);
    await this.openEdit();
  }

  ngOnDestroy(): void {
    this._sub?.unsubscribe();
    // Best-effort release on component destroy
    if (this.lockState.status === 'owned') {
      this.lockService.releaseLock(this.recordId);
    }
  }

  @HostListener('window:beforeunload')
  onBeforeUnload(): void {
    if (this.lockState.status === 'owned') {
      // Best-effort synchronous release — navigator.sendBeacon would be more reliable
      this.lockService.releaseLock(this.recordId);
    }
  }

  async openEdit(): Promise<void> {
    const { userId, displayName } = this.auth.currentUser;
    await this.lockService.acquireLock(this.recordId, userId, displayName);
    // acquireLock invokes the SignalR hub which responds via lockAcquired/lockRejected
    // events. Those events update the BehaviorSubject synchronously, but the Angular
    // subscription (this.lockState = state) runs in the same microtask queue.
    // Yield one microtask so the subscription callback has run before we read lockState.
    await Promise.resolve();
    if (this.lockState.status === 'owned') {
      this.lockService.startHeartbeat(this.recordId);
      this.statusMessage = '';
    }
  }

  async save(): Promise<void> {
    if (this.lockState.status !== 'owned') return;
    this.isSaving = true;
    // Simulate async save
    await new Promise((r) => setTimeout(r, 600));
    this.isSaving = false;
    await this.lockService.releaseLock(this.recordId);
    this.closed.emit();
  }

  async cancel(): Promise<void> {
    if (this.lockState.status !== 'owned') return;
    await this.lockService.releaseLock(this.recordId);
    this.closed.emit();
  }

  async tryAcquire(): Promise<void> {
    await this.openEdit();
  }

  async forceRelease(): Promise<void> {
    await this.lockService.forceRelease(this.recordId);
  }

  private _populateFormFromMockData(): void {
    const record = MOCK_RECORDS.find(r => r.id === this.recordId);
    if (record) {
      this.form.patchValue({
        title: record.title,
        description: record.description,
        status: record.status,
      });
    }
  }

  private _syncFormState(): void {
    if (this.lockState.status === 'owned') {
      this.form.enable();
    } else {
      this.form.disable();
    }
  }

  get isEditing(): boolean {
    return this.lockState.status === 'owned';
  }

  get isLockedByOther(): boolean {
    return this.lockState.status === 'locked-by-other';
  }

  get isUnlocked(): boolean {
    return this.lockState.status === 'unlocked';
  }
}

