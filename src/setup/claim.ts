/**
 * Claiming a fresh install (#405).
 *
 * A server in setup mode is reachable by anyone who finds its address, and
 * whoever finishes the wizard owns it. So the wizard first asks for a setup
 * code that only the server's operator can see: the server prints it in its
 * own log when it starts (on Railway: the service's Deploy Logs).
 *
 *  - The code is 20 characters from Crockford's base32 alphabet (100 bits),
 *    shown as four groups of five. Spaces, dashes and letter case are ignored
 *    when it is typed back.
 *  - Only its SHA-256 is kept, and comparison is constant-time.
 *  - It lives in this process's memory: each start prints a new one.
 *  - Wrong guesses are limited per address (5 per 15 minutes), and after 25
 *    wrong guesses in total the code is replaced by a new one, printed again.
 *  - A correct code opens a session (an HttpOnly, SameSite=Strict cookie
 *    scoped to /setup) that lasts two hours of inactivity.
 *  - Once setup is finished the server restarts out of setup mode, and the
 *    code, the sessions and every setup route are gone with it.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U
export const MAX_FAILURES_PER_ADDRESS = 5;
export const ADDRESS_WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_CODE = 25;
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;

export function generateSetupCode(): string {
  let raw = '';
  for (let i = 0; i < 20; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return raw.match(/.{5}/g)!.join('-');
}

/** Upper-case, drop separators, and read the letters people confuse with digits as Crockford does. */
export function normalizeSetupCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

function digest(code: string): Buffer {
  return createHash('sha256').update(normalizeSetupCode(code)).digest();
}

export type ClaimResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: 'wrong-code' | 'too-many-attempts'; retryAfterSeconds?: number };

export interface ClaimGuardOptions {
  /** Called with each new code, including the first: print it to the log. */
  announce: (code: string) => void;
  now?: () => number;
}

export class ClaimGuard {
  private codeHash: Buffer;
  private failuresForCode = 0;
  private readonly failuresByAddress = new Map<string, number[]>();
  private readonly sessions = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly options: ClaimGuardOptions) {
    this.now = options.now ?? Date.now;
    this.codeHash = this.newCode();
  }

  private newCode(): Buffer {
    const code = generateSetupCode();
    this.failuresForCode = 0;
    this.options.announce(code);
    return digest(code);
  }

  claim(code: string, address: string): ClaimResult {
    const now = this.now();
    const recent = (this.failuresByAddress.get(address) ?? []).filter((t) => now - t < ADDRESS_WINDOW_MS);
    if (recent.length >= MAX_FAILURES_PER_ADDRESS) {
      this.failuresByAddress.set(address, recent);
      return { ok: false, reason: 'too-many-attempts', retryAfterSeconds: Math.ceil((recent[0] + ADDRESS_WINDOW_MS - now) / 1000) };
    }
    if (typeof code === 'string' && code.length <= 64 && timingSafeEqual(digest(code), this.codeHash)) {
      this.failuresByAddress.delete(address);
      const sessionId = randomBytes(32).toString('hex');
      this.sessions.set(sessionId, now);
      return { ok: true, sessionId };
    }
    recent.push(now);
    this.failuresByAddress.set(address, recent);
    this.failuresForCode += 1;
    if (this.failuresForCode >= MAX_FAILURES_PER_CODE) this.codeHash = this.newCode();
    return { ok: false, reason: 'wrong-code' };
  }

  /** Whether the session is current; touching it extends it. */
  hasSession(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    const last = this.sessions.get(sessionId);
    if (last === undefined) return false;
    const now = this.now();
    if (now - last > SESSION_IDLE_MS) {
      this.sessions.delete(sessionId);
      return false;
    }
    this.sessions.set(sessionId, now);
    return true;
  }

  /** Setup is finished: nothing opens the wizard again in this process. */
  lock(): void {
    this.sessions.clear();
    this.codeHash = randomBytes(32); // matches no code anyone was shown
    this.failuresForCode = -Infinity;
  }
}
