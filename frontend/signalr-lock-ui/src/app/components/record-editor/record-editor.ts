import {
  Component,
  Input,
  OnInit,
  OnDestroy,
  HostListener,
} from '@angular/core';
import { FormBuilder, FormGroup } from '@angular/forms';
import { Subscription } from 'rxjs';
import { LockService } from '../../services/lock';
import { MockAuth } from '../../services/mock-auth';
import { LockState } from '../../models/lock.model';

@Component({
  selector: 'app-record-editor',
  standalone: false,
  templateUrl: './record-editor.html',
  styleUrl: './record-editor.css',
})
export class RecordEditor implements OnInit, OnDestroy {
  @Input() recordId = 'demo-record-1';

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
      title: ['Sample Record Title'],
      description: ['Edit this field to test record-level locking.'],
      status: ['active'],
    });
  }

  async ngOnInit(): Promise<void> {
    this._sub = this.lockService.lockState$.subscribe((state) => {
      this.lockState = state;
      this._syncFormState();
    });

    await this.lockService.subscribeToRecord(this.recordId);
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
    this.statusMessage = '✅ Record saved successfully.';
    this.isSaving = false;
    await this.lockService.releaseLock(this.recordId);
  }

  async cancel(): Promise<void> {
    if (this.lockState.status !== 'owned') return;
    await this.lockService.releaseLock(this.recordId);
    this.statusMessage = '';
  }

  async tryAcquire(): Promise<void> {
    await this.openEdit();
  }

  async forceRelease(): Promise<void> {
    await this.lockService.forceRelease(this.recordId);
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

