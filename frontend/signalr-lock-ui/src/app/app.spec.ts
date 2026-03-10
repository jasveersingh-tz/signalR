import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { App } from './app';
import { RecordEditor } from './components/record-editor/record-editor';
import { LockBanner } from './components/lock-banner/lock-banner';
import { ReactiveFormsModule } from '@angular/forms';
import { LockService } from './services/lock';
import { MockAuth } from './services/mock-auth';
import { of } from 'rxjs';

describe('App', () => {
  const mockLockService = {
    lockState$: of({ status: 'unlocked' }),
    subscribeToRecord: vi.fn().mockResolvedValue(undefined),
    acquireLock: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    forceRelease: vi.fn().mockResolvedValue(undefined),
    startHeartbeat: vi.fn(),
  };

  const mockAuth = {
    currentUser: { userId: 'u1', displayName: 'Demo User', isAdmin: false },
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [App, RecordEditor, LockBanner],
      imports: [ReactiveFormsModule],
      providers: [
        { provide: LockService, useValue: mockLockService },
        { provide: MockAuth, useValue: mockAuth },
      ],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render header title', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('SignalR Record-Level Locking');
  });
});
