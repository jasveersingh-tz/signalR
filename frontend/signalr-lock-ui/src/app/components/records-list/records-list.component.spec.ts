import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { By } from '@angular/platform-browser';
import { RecordsListComponent } from './records-list.component';
import { RecordListItem } from '../../models';

const freeRecord: RecordListItem = {
  id: 'r1',
  name: 'Invoice 001',
  status: 'active',
  updatedAt: '2024-06-01T10:00:00Z',
  isLocked: false,
};

const lockedRecord: RecordListItem = {
  id: 'r2',
  name: 'Invoice 002',
  status: 'draft',
  updatedAt: '2024-06-01T11:00:00Z',
  isLocked: true,
  lockedByDisplayName: 'Alice',
  lockedAtUtc: '2024-06-01T11:05:00Z',
};

describe('RecordsListComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RecordsListComponent],
    }).compileComponents();
  });

  it('should create', () => {
    const fixture = TestBed.createComponent(RecordsListComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should render a row for each record', () => {
    const fixture = TestBed.createComponent(RecordsListComponent);
    fixture.componentRef.setInput('records', [freeRecord, lockedRecord]);
    fixture.detectChanges();

    const rows = fixture.debugElement.queryAll(By.css('tbody tr'));
    expect(rows.length).toBe(2);
  });

  it('should render green free-lock and red locked-lock styles', () => {
    const fixture = TestBed.createComponent(RecordsListComponent);
    fixture.componentRef.setInput('records', [freeRecord, lockedRecord]);
    fixture.detectChanges();

    const icons = fixture.debugElement.queryAll(By.css('.lock-icon'));
    expect(icons[0].nativeElement.classList.contains('lock--free')).toBe(true);
    expect(icons[1].nativeElement.classList.contains('lock--locked')).toBe(true);

    const svgs = fixture.debugElement.queryAll(By.css('.lock-icon__svg'));
    expect(svgs.length).toBe(2);
  });

  it('should emit openRecord when a row is clicked', () => {
    const fixture = TestBed.createComponent(RecordsListComponent);
    const spy = vi.fn();
    fixture.componentRef.setInput('records', [freeRecord]);
    fixture.componentInstance.openRecord.subscribe(spy);
    fixture.detectChanges();

    const row = fixture.debugElement.query(By.css('tbody tr'));
    row.triggerEventHandler('click', null);

    expect(spy).toHaveBeenCalledWith(freeRecord);
  });

  it('should not emit openRecord when pendingAcquireRecordId matches the clicked row', () => {
    const fixture = TestBed.createComponent(RecordsListComponent);
    const spy = vi.fn();
    fixture.componentRef.setInput('records', [freeRecord]);
    fixture.componentRef.setInput('pendingAcquireRecordId', 'r1');
    fixture.componentInstance.openRecord.subscribe(spy);
    fixture.detectChanges();

    const row = fixture.debugElement.query(By.css('tbody tr'));
    row.triggerEventHandler('click', null);

    expect(spy).not.toHaveBeenCalled();
  });

  it('should show loading message when loading=true', () => {
    const fixture = TestBed.createComponent(RecordsListComponent);
    fixture.componentRef.setInput('records', []);
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent;
    expect(text).toContain('Loading');
  });

  it('should show error message when error is set', () => {
    const fixture = TestBed.createComponent(RecordsListComponent);
    fixture.componentRef.setInput('records', []);
    fixture.componentRef.setInput('error', 'Network error');
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent;
    expect(text).toContain('Network error');
  });

  it('lockClass should return lock--locked for locked record', () => {
    const fixture = TestBed.createComponent(RecordsListComponent);
    expect(fixture.componentInstance.lockClass(lockedRecord)).toBe('lock--locked');
    expect(fixture.componentInstance.lockClass(freeRecord)).toBe('lock--free');
  });

  it('lockTooltip should mention the user for a locked record', () => {
    const fixture = TestBed.createComponent(RecordsListComponent);
    expect(fixture.componentInstance.lockTooltip(lockedRecord)).toContain('Alice');
    expect(fixture.componentInstance.lockTooltip(freeRecord)).toContain('Available');
  });
});
