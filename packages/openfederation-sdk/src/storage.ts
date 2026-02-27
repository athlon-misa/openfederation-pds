export interface StorageAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export class LocalStorageAdapter implements StorageAdapter {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // localStorage may be full or blocked
    }
  }

  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
}

export class SessionStorageAdapter implements StorageAdapter {
  get(key: string): string | null {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // sessionStorage may be blocked
    }
  }

  remove(key: string): void {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
}

export class MemoryStorageAdapter implements StorageAdapter {
  private store = new Map<string, string>();

  get(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.store.set(key, value);
  }

  remove(key: string): void {
    this.store.delete(key);
  }
}

export function createStorage(type: 'local' | 'session' | 'memory'): StorageAdapter {
  switch (type) {
    case 'session':
      return new SessionStorageAdapter();
    case 'memory':
      return new MemoryStorageAdapter();
    case 'local':
    default:
      return new LocalStorageAdapter();
  }
}
