import { Injectable } from '@angular/core';

/** Shape of the logged-in user. Replace with a real JWT/OIDC claims interface in production. */
export interface CurrentUser {
  userId: string;
  displayName: string;
  isAdmin: boolean;
}

const STORAGE_KEY = 'mockUser';

/**
 * MockAuth — minimal stub that simulates an authenticated user.
 *
 * In a real application, replace this service with one that reads identity
 * from a JWT, OIDC session, or an auth library (e.g. MSAL, Auth0 Angular SDK).
 *
 * The generated userId and displayName are persisted to `localStorage` so the
 * identity survives page refreshes during local development / testing.
 */
@Injectable({ providedIn: 'root' })
export class MockAuth {
  private _user: CurrentUser;

  constructor() {
    // Restore existing identity or generate a new random one
    const stored = localStorage.getItem(STORAGE_KEY);
    this._user = stored
      ? (JSON.parse(stored) as CurrentUser)
      : this._createAndPersist();
  }

  /** The currently authenticated user. */
  get currentUser(): CurrentUser {
    return this._user;
  }

  /** Overwrite the display name (useful in dev/test to simulate different users). */
  setDisplayName(name: string): void {
    this._persist({ ...this._user, displayName: name });
  }

  /** Toggle admin role (enables Force-unlock UI in the editor). */
  setAdmin(isAdmin: boolean): void {
    this._persist({ ...this._user, isAdmin });
  }

  // ── Private helpers ──────────────────────────────────────────────

  private _createAndPersist(): CurrentUser {
    const user: CurrentUser = {
      userId: `user-${Math.random().toString(36).slice(2, 8)}`,
      displayName: `User ${Math.floor(Math.random() * 1000)}`,
      isAdmin: false,
    };
    return this._persist(user);
  }

  private _persist(user: CurrentUser): CurrentUser {
    this._user = user;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    return user;
  }
}

