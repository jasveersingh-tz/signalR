import { Component, Input, Output, EventEmitter } from '@angular/core';
import { LockInfo } from '../../models/lock.model';

@Component({
  selector: 'app-lock-banner',
  standalone: false,
  templateUrl: './lock-banner.html',
  styleUrl: './lock-banner.css',
})
export class LockBanner {
  @Input() lock!: LockInfo;
  @Input() isOwnLock = false;
  @Input() isAdmin = false;
  @Output() tryAcquire = new EventEmitter<void>();
  @Output() forceRelease = new EventEmitter<void>();

  get lockedSince(): string {
    const diff = Date.now() - new Date(this.lock.acquiredAtUtc).getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ago`;
  }
}

