import type { StorageAdapter } from './storage.js';
import type { User } from './types.js';

const KEYS = {
  accessJwt: 'access_jwt',
  refreshJwt: 'refresh_jwt',
  user: 'user',
} as const;

/**
 * Manages token storage, JWT expiry decoding, and auto-refresh scheduling.
 */
export class TokenManager {
  private prefix: string;
  private storage: StorageAdapter;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private onRefreshNeeded: (() => Promise<void>) | null = null;

  constructor(storage: StorageAdapter, prefix: string) {
    this.storage = storage;
    this.prefix = prefix;
  }

  private key(name: string): string {
    return this.prefix + name;
  }

  getAccessJwt(): string | null {
    return this.storage.get(this.key(KEYS.accessJwt));
  }

  getRefreshJwt(): string | null {
    return this.storage.get(this.key(KEYS.refreshJwt));
  }

  getUser(): User | null {
    const raw = this.storage.get(this.key(KEYS.user));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as User;
    } catch {
      return null;
    }
  }

  setTokens(accessJwt: string, refreshJwt: string, user: User): void {
    this.storage.set(this.key(KEYS.accessJwt), accessJwt);
    this.storage.set(this.key(KEYS.refreshJwt), refreshJwt);
    this.storage.set(this.key(KEYS.user), JSON.stringify(user));
    this.scheduleRefresh(accessJwt);
  }

  clear(): void {
    this.cancelRefresh();
    this.storage.remove(this.key(KEYS.accessJwt));
    this.storage.remove(this.key(KEYS.refreshJwt));
    this.storage.remove(this.key(KEYS.user));
  }

  hasTokens(): boolean {
    return this.getAccessJwt() !== null && this.getRefreshJwt() !== null;
  }

  /** Set the callback for when a refresh is needed */
  setRefreshCallback(cb: () => Promise<void>): void {
    this.onRefreshNeeded = cb;
    // If we already have tokens, schedule refresh
    const jwt = this.getAccessJwt();
    if (jwt) {
      this.scheduleRefresh(jwt);
    }
  }

  /** Decode JWT expiry (no verification — just reads the `exp` claim) */
  private getTokenExpiry(jwt: string): number | null {
    try {
      const parts = jwt.split('.');
      if (parts.length !== 3) return null;
      // base64url decode the payload
      const payload = parts[1]
        .replace(/-/g, '+')
        .replace(/_/g, '/');
      const decoded = atob(payload);
      const parsed = JSON.parse(decoded);
      return typeof parsed.exp === 'number' ? parsed.exp : null;
    } catch {
      return null;
    }
  }

  /** Schedule a refresh 60 seconds before token expiry */
  private scheduleRefresh(accessJwt: string): void {
    this.cancelRefresh();
    if (!this.onRefreshNeeded) return;

    const exp = this.getTokenExpiry(accessJwt);
    if (!exp) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const refreshInSec = exp - nowSec - 60; // 60s before expiry

    if (refreshInSec <= 0) {
      // Token already expired or about to — refresh immediately
      this.onRefreshNeeded();
      return;
    }

    this.refreshTimer = setTimeout(() => {
      this.onRefreshNeeded?.();
    }, refreshInSec * 1000);
  }

  private cancelRefresh(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  destroy(): void {
    this.cancelRefresh();
    this.onRefreshNeeded = null;
  }
}
