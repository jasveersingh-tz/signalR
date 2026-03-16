import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { BehaviorSubject } from 'rxjs';
import { signal } from '@angular/core';

import { App } from './app';
import { RecordEditor } from './components/record-editor/record-editor';
import { LockBanner } from './components/lock-banner/lock-banner';
import { ReactiveFormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { LockService } from './services/lock';
import { RecordsService } from './services/records.service';
import { MockAuth } from './services/mock-auth';
import { RecordsListComponent } from './components/records-list/records-list.component';
import { RecordDialogComponent } from './components/record-dialog/record-dialog.component';
import { RecordListItem } from './models';

const mockRecord: RecordListItem = {
  id: 'r1',
  name: 'Test Record',
  status: 'active',
  updatedAt: '2024-01-01T00:00:00Z',
  isLocked: false,
};

describe('App', () => {
  const connectionLost$ = new BehaviorSubject<boolean>(false);

  const mockLockService = {
    connectionLost$: connectionLost$.asObservable(),
    lockState$: new BehaviorSubject({ status: 'unlocked' }).asObservable(),
    subscribeToRecord: vi.fn().mockResolvedValue(undefined),
    subscribeToRecords: vi.fn().mockResolvedValue(undefined),
    acquireLock: vi.fn().mockResolvedValue({ acquired: true }),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    releaseLockWithRetry: vi.fn().mockResolvedValue(true),
    startHeartbeat: vi.fn(),
  };

  const recordsSignal = signal<RecordListItem[]>([mockRecord]);
  const loadingSignal = signal(false);
  const errorSignal = signal<string | null>(null);

  const mockRecordsService = {
    records: recordsSignal,
    loading: loadingSignal,
    error: errorSignal,
    refresh: vi.fn().mockResolvedValue(undefined),
    patchLock: vi.fn(),
    updateRecord: vi.fn(),
  };

  const mockAuth = {
    currentUser: { userId: 'u1', displayName: 'Demo User', isAdmin: false },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    await TestBed.configureTestingModule({
      declarations: [App, RecordEditor, LockBanner],
      imports: [
        ReactiveFormsModule,
        RouterModule.forRoot([]),
        RecordsListComponent,
        RecordDialogComponent,
      ],
      providers: [
        { provide: LockService, useValue: mockLockService },
        { provide: RecordsService, useValue: mockRecordsService },
        { provide: MockAuth, useValue: mockAuth },
      ],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should render header title', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const h1 = (fixture.nativeElement as HTMLElement).querySelector('h1');
    expect(h1?.textContent).toContain('SignalR Record-Level Locking');
  });

  it('should call refresh(10) on init', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(mockRecordsService.refresh).toHaveBeenCalledWith(10);
  });

  it('should acquire lock and open dialog on onOpenRecord', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const app = fixture.componentInstance;

    await app.onOpenRecord(mockRecord);

    expect(mockLockService.acquireLock).toHaveBeenCalledWith('r1');
    expect(app.selectedRecord).not.toBeNull();
    expect(app.selectedRecord?.isLocked).toBe(true);
  });

  it('should show banner and not open dialog if acquireLock returns acquired=false', async () => {
    mockLockService.acquireLock.mockResolvedValueOnce({
      acquired: false,
      lock: { lockedByDisplayName: 'Alice' },
    });

    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const app = fixture.componentInstance;

    await app.onOpenRecord(mockRecord);

    expect(app.selectedRecord).toBeNull();
    expect(app.bannerMessage).toContain('Alice');
  });

  it('should show banner without calling acquireLock if record is locked by another user', async () => {
    const lockedRecord: RecordListItem = {
      ...mockRecord,
      isLocked: true,
      lockedByDisplayName: 'Bob',
    };

    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const app = fixture.componentInstance;

    await app.onOpenRecord(lockedRecord);

    expect(mockLockService.acquireLock).not.toHaveBeenCalled();
    expect(app.bannerMessage).toContain('Bob');
  });

  it('should clear stale locked-record banner when opening an available record', async () => {
    const lockedRecord: RecordListItem = {
      ...mockRecord,
      id: 'r2',
      isLocked: true,
      lockedByDisplayName: 'Bob',
    };

    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const app = fixture.componentInstance;

    await app.onOpenRecord(lockedRecord);
    expect(app.bannerMessage).toContain('Bob');

    await app.onOpenRecord(mockRecord);

    expect(mockLockService.acquireLock).toHaveBeenCalledWith('r1');
    expect(app.selectedRecord?.id).toBe('r1');
    expect(app.bannerMessage).toBe('');
  });

  it('should clear selectedRecord on dialog closed', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const app = fixture.componentInstance;

    app.selectedRecord = { ...mockRecord };
    app.onDialogClosed({ saved: false, releaseFailed: false });

    expect(app.selectedRecord).toBeNull();
  });

  it('should show release-failed banner when dialog closes with releaseFailed=true', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const app = fixture.componentInstance;

    app.selectedRecord = { ...mockRecord };
    app.onDialogClosed({ saved: false, releaseFailed: true });

    expect(app.bannerMessage).toBeTruthy();
  });

  it('should not call acquireLock when pendingAcquireRecordId matches', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const app = fixture.componentInstance;

    app.pendingAcquireRecordId = 'r1';
    await app.onOpenRecord(mockRecord);

    expect(mockLockService.acquireLock).not.toHaveBeenCalled();
  });
});
