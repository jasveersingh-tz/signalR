import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { ReactiveFormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { RecordDialogComponent, RecordDialogCloseEvent } from './record-dialog.component';
import { BehaviorSubject } from 'rxjs';
import { LockState, RecordListItem } from '../../models';
import { LockService } from '../../services/lock';
import { RecordsService } from '../../services/records.service';
import { signal } from '@angular/core';

const mockRecord: RecordListItem = {
  id: 'r1',
  name: 'Test Record',
  status: 'active',
  updatedAt: '2024-01-01T00:00:00Z',
  isLocked: true,
  lockedByDisplayName: 'Demo User',
};

describe('RecordDialogComponent', () => {
  const lockState$ = new BehaviorSubject<LockState>({ status: 'owned', lock: {
    recordId: 'r1',
    lockedByUserId: 'u1',
    lockedByDisplayName: 'Demo User',
    acquiredAtUtc: '2024-01-01T00:00:00Z',
    expiresAtUtc: '2024-01-01T00:30:00Z',
    connectionId: 'c1',
  } });

  const mockLockService = {
    lockState$: lockState$.asObservable(),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    releaseLockWithRetry: vi.fn().mockResolvedValue(true),
  };

  const mockRecordsService = {
    records: signal([mockRecord]),
    loading: signal(false),
    error: signal(null),
    refresh: vi.fn().mockResolvedValue(undefined),
    patchLock: vi.fn(),
    updateRecord: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    lockState$.next({ status: 'owned', lock: {
      recordId: 'r1',
      lockedByUserId: 'u1',
      lockedByDisplayName: 'Demo User',
      acquiredAtUtc: '2024-01-01T00:00:00Z',
      expiresAtUtc: '2024-01-01T00:30:00Z',
      connectionId: 'c1',
    } });
    await TestBed.configureTestingModule({
      imports: [RecordDialogComponent, ReactiveFormsModule, RouterModule.forRoot([])],
      providers: [
        { provide: LockService, useValue: mockLockService },
        { provide: RecordsService, useValue: mockRecordsService },
      ],
    }).compileComponents();
  });

  function createComponent() {
    const fixture = TestBed.createComponent(RecordDialogComponent);
    fixture.componentRef.setInput('record', mockRecord);
    fixture.detectChanges();
    return fixture;
  }

  it('should create', () => {
    const fixture = createComponent();
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should pre-populate form with record values', () => {
    const fixture = createComponent();
    const { name, status } = fixture.componentInstance.form.value;
    expect(name).toBe('Test Record');
    expect(status).toBe('active');
  });

  it('should call releaseLockWithRetry and emit closed on cancel', async () => {
    const fixture = createComponent();
    const emittedEvents: RecordDialogCloseEvent[] = [];
    fixture.componentInstance.closed.subscribe((e) => emittedEvents.push(e));

    await fixture.componentInstance.cancel();

    expect(mockLockService.releaseLockWithRetry).toHaveBeenCalledWith('r1');
    expect(emittedEvents.length).toBe(1);
    expect(emittedEvents[0].saved).toBe(false);
    expect(emittedEvents[0].releaseFailed).toBe(false);
  });

  it('should call updateRecord and releaseLockWithRetry on save', async () => {
    const fixture = createComponent();
    const emittedEvents: RecordDialogCloseEvent[] = [];
    fixture.componentInstance.closed.subscribe((e) => emittedEvents.push(e));

    await fixture.componentInstance.save();

    expect(mockRecordsService.updateRecord).toHaveBeenCalledWith('r1', {
      name: 'Test Record',
      status: 'active',
    });
    expect(mockLockService.releaseLockWithRetry).toHaveBeenCalledWith('r1');
    expect(emittedEvents[0].saved).toBe(true);
  });

  it('should set releaseFailed=true when releaseLockWithRetry returns false', async () => {
    mockLockService.releaseLockWithRetry.mockResolvedValueOnce(false);

    const fixture = createComponent();
    const emittedEvents: RecordDialogCloseEvent[] = [];
    fixture.componentInstance.closed.subscribe((e) => emittedEvents.push(e));

    await fixture.componentInstance.cancel();

    expect(emittedEvents[0].releaseFailed).toBe(true);
    expect(fixture.componentInstance.releaseWarning).toBeTruthy();
  });

  it('should not call releaseLockWithRetry twice if cancel called twice', async () => {
    const fixture = createComponent();
    await fixture.componentInstance.cancel();
    await fixture.componentInstance.cancel();

    expect(mockLockService.releaseLockWithRetry).toHaveBeenCalledTimes(1);
  });

  it('should show session-timeout prompt when connectionLost=true', () => {
    const fixture = TestBed.createComponent(RecordDialogComponent);
    fixture.componentRef.setInput('record', mockRecord);
    fixture.componentRef.setInput('connectionLost', true);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text.toLowerCase()).toContain('session timed out');
    expect(text.toLowerCase()).toContain('connection was lost');
  });

  it('should show session-timeout prompt when lock becomes unlocked after being owned', () => {
    const fixture = createComponent();

    lockState$.next({ status: 'unlocked' });
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text.toLowerCase()).toContain('session timed out');
    expect(text.toLowerCase()).toContain('inactivity');
  });

  it('should show session-timeout prompt when lock is acquired by another user', () => {
    const fixture = createComponent();

    lockState$.next({
      status: 'locked-by-other',
      lock: {
        recordId: 'r1',
        lockedByUserId: 'u2',
        lockedByDisplayName: 'Alice',
        acquiredAtUtc: '2024-01-01T00:01:00Z',
        expiresAtUtc: '2024-01-01T00:31:00Z',
        connectionId: 'c2',
      },
    });
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text.toLowerCase()).toContain('session timed out');
    expect(text.toLowerCase()).toContain('locked by another user');
  });

  it('should close modal when timeout prompt OK is clicked', async () => {
    const fixture = createComponent();
    const emittedEvents: RecordDialogCloseEvent[] = [];
    fixture.componentInstance.closed.subscribe((event) => emittedEvents.push(event));

    lockState$.next({ status: 'unlocked' });
    fixture.detectChanges();

    await fixture.componentInstance.acknowledgeSessionTimeout();

    expect(mockLockService.releaseLockWithRetry).toHaveBeenCalledWith('r1');
    expect(emittedEvents.length).toBe(1);
    expect(emittedEvents[0].saved).toBe(false);
  });
});
