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
import { LockRequest, LockState } from '../../models/lock.model';
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
  incomingRequests: LockRequest[] = [];
  requestPending = false;

  private _sub?: Subscription;
  private _lockRequestedSub?: Subscription;
  private _requestPendingTimer: ReturnType<typeof setTimeout> | null = null;
  private _requestDismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

    this._lockRequestedSub = this.lockService.lockRequested$.subscribe((req) => {
      if (req.recordId !== this.recordId) return;
      // Ignore duplicate requests from the same requester
      if (this._requestDismissTimers.has(req.requesterConnectionId)) return;
      this.incomingRequests = [...this.incomingRequests, req];
      const timer = setTimeout(
        () => this._dismissRequest(req.requesterConnectionId),
        5 * 60 * 1000,
      );
      this._requestDismissTimers.set(req.requesterConnectionId, timer);
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
    this._lockRequestedSub?.unsubscribe();
    if (this._requestPendingTimer !== null) clearTimeout(this._requestPendingTimer);
    this._requestDismissTimers.forEach((t) => clearTimeout(t));
    this._requestDismissTimers.clear();
    this.incomingRequests = [];
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

  async requestAccess(): Promise<void> {
    this.requestPending = true;
    this._requestPendingTimer = setTimeout(() => {
      this.requestPending = false;
      this._requestPendingTimer = null;
    }, 5 * 60 * 1000);
    await this.lockService.requestAccess(this.recordId);
  }

  async saveAndAccept(req: LockRequest): Promise<void> {
    this.isSaving = true;
    await new Promise((r) => setTimeout(r, 600));
    this.isSaving = false;
    await this.lockService.acceptAccessRequest(
      this.recordId,
      req.requesterId,
      req.requesterDisplayName,
      req.requesterConnectionId,
    );
    this._clearAllRequests();
  }

  async discardAndAccept(req: LockRequest): Promise<void> {
    await this.lockService.acceptAccessRequest(
      this.recordId,
      req.requesterId,
      req.requesterDisplayName,
      req.requesterConnectionId,
    );
    this._clearAllRequests();
  }

  rejectRequest(req: LockRequest): void {
    this._dismissRequest(req.requesterConnectionId);
  }

  private _clearAllRequests(): void {
    this._requestDismissTimers.forEach((t) => clearTimeout(t));
    this._requestDismissTimers.clear();
    this.incomingRequests = [];
  }

  private _dismissRequest(requesterConnectionId: string): void {
    this.incomingRequests = this.incomingRequests.filter(
      (r) => r.requesterConnectionId !== requesterConnectionId,
    );
    const timer = this._requestDismissTimers.get(requesterConnectionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this._requestDismissTimers.delete(requesterConnectionId);
    }
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

