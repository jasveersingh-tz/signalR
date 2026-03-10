import { Injectable } from '@angular/core';

export interface CurrentUser {
  userId: string;
  displayName: string;
  isAdmin: boolean;
}

/** Minimal mock authentication service — replace with real auth in production. */
@Injectable({ providedIn: 'root' })
export class MockAuth {
  private _user: CurrentUser;

  constructor() {
    // Use localStorage so the identity persists across page refreshes in the demo.
    const stored = localStorage.getItem('mockUser');
    if (stored) {
      this._user = JSON.parse(stored) as CurrentUser;
    } else {
      this._user = {
        userId: `user-${Math.random().toString(36).slice(2, 8)}`,
        displayName: `User ${Math.floor(Math.random() * 1000)}`,
        isAdmin: false,
      };
      localStorage.setItem('mockUser', JSON.stringify(this._user));
    }
  }

  get currentUser(): CurrentUser {
    return this._user;
  }

  setDisplayName(name: string): void {
    this._user = { ...this._user, displayName: name };
    localStorage.setItem('mockUser', JSON.stringify(this._user));
  }

  setAdmin(isAdmin: boolean): void {
    this._user = { ...this._user, isAdmin };
    localStorage.setItem('mockUser', JSON.stringify(this._user));
  }
}

