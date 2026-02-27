/**
 * ofc CLI — XRPC HTTP client
 *
 * Features:
 *   - Auto token refresh on 401
 *   - XDG-compliant session storage (~/.config/ofc/session.json)
 *   - Interactive password prompting (readline, hidden input)
 *   - --password-stdin support for scripted use
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

// ── Types ───────────────────────────────────────────────────────────

export interface StoredSession {
  serverUrl: string;
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle: string;
}

// ── Session storage (XDG) ───────────────────────────────────────────

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg || join(homedir(), '.config'), 'ofc');
}

function sessionFile(): string {
  return join(configDir(), 'session.json');
}

export function loadSession(serverUrl: string): StoredSession | null {
  try {
    const f = sessionFile();
    if (!existsSync(f)) return null;
    const data = JSON.parse(readFileSync(f, 'utf-8'));
    if (data.serverUrl === serverUrl) return data as StoredSession;
    return null;
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(sessionFile(), JSON.stringify(session, null, 2), { mode: 0o600 });
}

export function clearSession(): void {
  try {
    const f = sessionFile();
    if (existsSync(f)) writeFileSync(f, '{}', { mode: 0o600 });
  } catch {
    // ignore
  }
}

// ── Password prompting ──────────────────────────────────────────────

/** Interactive password prompt (hidden input). */
export function promptPassword(prompt = 'Password: '): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('No TTY available for password prompt. Use --password-stdin for non-interactive use.'));
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    // Mute output while typing password
    process.stderr.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);

    let password = '';
    const onData = (ch: Buffer) => {
      const c = ch.toString('utf-8');
      if (c === '\n' || c === '\r' || c === '\u0004') {
        // Enter or Ctrl-D
        stdin.setRawMode(wasRaw ?? false);
        stdin.removeListener('data', onData);
        rl.close();
        process.stderr.write('\n');
        resolve(password);
      } else if (c === '\u0003') {
        // Ctrl-C
        stdin.setRawMode(wasRaw ?? false);
        stdin.removeListener('data', onData);
        rl.close();
        process.stderr.write('\n');
        process.exit(130);
      } else if (c === '\u007f' || c === '\b') {
        // Backspace
        password = password.slice(0, -1);
      } else {
        password += c;
      }
    };
    stdin.on('data', onData);
  });
}

/** Read password from stdin pipe. */
export function readPasswordStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(new Error('--password-stdin requires piped input (e.g. echo "pass" | ofc auth login -u admin --password-stdin)'));
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
    process.stdin.resume();
  });
}

// ── XRPC Client ─────────────────────────────────────────────────────

export class OFCClient {
  private serverUrl: string;
  private timeoutMs: number;

  constructor(serverUrl: string, timeoutMs: number = 30_000) {
    // Normalize: strip trailing slash
    this.serverUrl = serverUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  // ── Raw HTTP ────────────────────────────────────────────────────

  private async rawFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Unauthenticated requests ────────────────────────────────────

  async get(nsid: string, params?: Record<string, string>): Promise<any> {
    const url = new URL(`/xrpc/${nsid}`, this.serverUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, v);
      }
    }
    const resp = await this.rawFetch(url.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    return this.handleResponse(resp);
  }

  async post(nsid: string, body?: Record<string, any>): Promise<any> {
    const url = new URL(`/xrpc/${nsid}`, this.serverUrl);
    const resp = await this.rawFetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return this.handleResponse(resp);
  }

  /** GET /health (non-XRPC). */
  async healthCheck(): Promise<any> {
    const resp = await this.rawFetch(`${this.serverUrl}/health`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    return this.handleResponse(resp);
  }

  // ── Authenticated requests (with auto-refresh) ─────────────────

  async authGet(nsid: string, params?: Record<string, string>): Promise<any> {
    const session = loadSession(this.serverUrl);
    if (!session) throw new Error('Not logged in. Run: ofc auth login');

    const url = new URL(`/xrpc/${nsid}`, this.serverUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, v);
      }
    }

    let resp = await this.rawFetch(url.toString(), {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${session.accessJwt}`, 'Accept': 'application/json' },
    });

    if (resp.status === 401) {
      const refreshed = await this.tryRefresh(session);
      if (!refreshed) throw new Error('Session expired. Run: ofc auth login');
      resp = await this.rawFetch(url.toString(), {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${refreshed.accessJwt}`, 'Accept': 'application/json' },
      });
    }

    return this.handleResponse(resp);
  }

  async authPost(nsid: string, body?: Record<string, any>): Promise<any> {
    const session = loadSession(this.serverUrl);
    if (!session) throw new Error('Not logged in. Run: ofc auth login');

    const url = new URL(`/xrpc/${nsid}`, this.serverUrl);

    let resp = await this.rawFetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.accessJwt}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (resp.status === 401) {
      const refreshed = await this.tryRefresh(session);
      if (!refreshed) throw new Error('Session expired. Run: ofc auth login');
      resp = await this.rawFetch(url.toString(), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${refreshed.accessJwt}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    }

    return this.handleResponse(resp);
  }

  // ── Session management ──────────────────────────────────────────

  async login(identifier: string, password: string): Promise<StoredSession> {
    const result = await this.post('com.atproto.server.createSession', { identifier, password });
    const session: StoredSession = {
      serverUrl: this.serverUrl,
      accessJwt: result.accessJwt,
      refreshJwt: result.refreshJwt,
      did: result.did,
      handle: result.handle,
    };
    saveSession(session);
    return session;
  }

  async logout(): Promise<void> {
    const session = loadSession(this.serverUrl);
    if (session) {
      try {
        await this.authPost('com.atproto.server.deleteSession', { refreshJwt: session.refreshJwt });
      } catch {
        // Best-effort server-side cleanup
      }
    }
    clearSession();
  }

  // ── Internals ───────────────────────────────────────────────────

  private async tryRefresh(session: StoredSession): Promise<StoredSession | null> {
    try {
      const url = new URL('/xrpc/com.atproto.server.refreshSession', this.serverUrl);
      const resp = await this.rawFetch(url.toString(), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.refreshJwt}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      });
      if (!resp.ok) {
        clearSession();
        return null;
      }
      const data = await resp.json();
      const refreshed: StoredSession = {
        serverUrl: this.serverUrl,
        accessJwt: data.accessJwt,
        refreshJwt: data.refreshJwt,
        did: data.did,
        handle: data.handle,
      };
      saveSession(refreshed);
      return refreshed;
    } catch {
      clearSession();
      return null;
    }
  }

  private async handleResponse(resp: Response): Promise<any> {
    if (resp.status === 204) return {};

    let data: any;
    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/json') || contentType.includes('application/did+json') || contentType.includes('application/jrd+json')) {
      data = await resp.json();
    } else {
      const text = await resp.text();
      try {
        data = JSON.parse(text);
      } catch {
        data = { text };
      }
    }

    if (!resp.ok) {
      const msg = data?.message || data?.error || `HTTP ${resp.status}`;
      throw new Error(msg);
    }
    return data;
  }
}
