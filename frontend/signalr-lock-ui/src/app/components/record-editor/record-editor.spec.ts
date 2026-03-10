import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ReactiveFormsModule } from '@angular/forms';
import { BehaviorSubject } from 'rxjs';
import { vi } from 'vitest';
import { RecordEditor } from './record-editor';
import { LockService } from '../../services/lock';
import { MockAuth } from '../../services/mock-auth';
import { LockBanner } from '../lock-banner/lock-banner';
import { LockState } from '../../models/lock.model';

describe('RecordEditor', () => {
  let component: RecordEditor;
  let fixture: ComponentFixture<RecordEditor>;
  let lockStateSubject: BehaviorSubject<LockState>;

  const mockLockService = {
    lockState$: new BehaviorSubject<LockState>({ status: 'unlocked' }).asObservable(),
    subscribeToRecord: vi.fn().mockResolvedValue(undefined),
    acquireLock: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    forceRelease: vi.fn().mockResolvedValue(undefined),
    startHeartbeat: vi.fn(),
  };

  const mockAuth = {
    currentUser: {
      userId: 'test-user',
      displayName: 'Test User',
      isAdmin: false,
    },
  };

  beforeEach(async () => {
    lockStateSubject = new BehaviorSubject<LockState>({ status: 'unlocked' });
    mockLockService.lockState$ = lockStateSubject.asObservable();

    await TestBed.configureTestingModule({
      declarations: [RecordEditor, LockBanner],
      imports: [ReactiveFormsModule],
      providers: [
        { provide: LockService, useValue: mockLockService },
        { provide: MockAuth, useValue: mockAuth },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RecordEditor);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should subscribe to record on init', () => {
    expect(mockLockService.subscribeToRecord).toHaveBeenCalledWith('demo-record-1');
  });

  it('should have form disabled when not editing', () => {
    expect(component.form.disabled).toBeTruthy();
  });

  it('should detect unlocked state', () => {
    lockStateSubject.next({ status: 'unlocked' });
    fixture.detectChanges();
    expect(component.isUnlocked).toBeTruthy();
    expect(component.isEditing).toBeFalsy();
    expect(component.isLockedByOther).toBeFalsy();
  });
});

