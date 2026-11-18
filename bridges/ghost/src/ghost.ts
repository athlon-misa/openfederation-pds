/**
 * The Ghost Admin API calls the bridge needs: find or create a member, get a
 * one-time sign-in link for them, and have Ghost email a sign-in link.
 *
 * Authenticated with a custom integration's Admin API key, as Ghost
 * documents: a 5-minute HS256 JWT, `kid` = key id, `aud` = /admin/.
 */
import { SignJWT } from 'jose';
import type { BridgeConfig } from './config.js';

export interface GhostMember {
  id: string;
  email: string;
  name: string | null;
  note: string | null;
}

/**
 * The note that ties a member to an AT Protocol identity. `confirmed`: the
 * member's email came verified from the person's own PDS, so the DID alone
 * may sign them in. Unconfirmed: the person typed the address; the DID then
 * only ever gets them a sign-in link emailed to that address, so typing
 * somebody else's address gains nothing.
 */
export function didNote(did: string, handle: string | null, confirmed: boolean): string {
  return `OpenFederation${confirmed ? '' : ' (email entered)'}: ${did}${handle ? ` (@${handle})` : ''}`;
}

export function noteConfirmsDid(note: string | null, did: string): boolean {
  return (note ?? '').startsWith(`OpenFederation: ${did}`);
}

export class GhostAdmin {
  constructor(private readonly cfg: BridgeConfig) {}

  private async token(): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: this.cfg.ghostAdminKey.id, typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .setAudience('/admin/')
      .sign(this.cfg.ghostAdminKey.secret);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.ghostInternalUrl}/ghost/api/admin${path}`, {
      method,
      headers: {
        Authorization: `Ghost ${await this.token()}`,
        'Accept-Version': 'v6.0',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Ghost ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  private nql(value: string): string {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }

  async findByEmail(email: string): Promise<GhostMember | null> {
    const r = await this.call<{ members: GhostMember[] }>('GET', `/members/?filter=${encodeURIComponent(`email:${this.nql(email)}`)}&limit=1`);
    return r.members[0] ?? null;
  }

  /** A member whose note names this DID, confirmed first (see didNote). */
  async findByDid(did: string): Promise<{ member: GhostMember; confirmed: boolean } | null> {
    const r = await this.call<{ members: GhostMember[] }>('GET', `/members/?filter=${encodeURIComponent(`note:~${this.nql(did)}`)}&limit=5`);
    const confirmed = r.members.find((m) => noteConfirmsDid(m.note, did));
    if (confirmed) return { member: confirmed, confirmed: true };
    const entered = r.members.find((m) => (m.note ?? '').includes(did));
    return entered ? { member: entered, confirmed: false } : null;
  }

  /**
   * Create a member. With `sendEmail`, Ghost emails them a sign-in link
   * (Admin API `send_email` / `email_type`), which is how an address typed by
   * the person is proven before they are signed in.
   */
  async createMember(input: { email: string; name: string | null; note: string; sendEmail?: boolean }): Promise<GhostMember> {
    const q = input.sendEmail ? '?send_email=true&email_type=signin' : '';
    const r = await this.call<{ members: GhostMember[] }>('POST', `/members/${q}`, {
      members: [{ email: input.email, name: input.name ?? undefined, note: input.note, labels: [{ name: 'openfederation' }] }],
    });
    return r.members[0];
  }

  /** Add the DID note to a member who has none yet (never overwrites a note). */
  async attachDid(member: GhostMember, note: string): Promise<void> {
    if (member.note && member.note.trim()) return;
    await this.call('PUT', `/members/${member.id}/`, { members: [{ note }] });
  }

  /** A one-time link that signs the member in on the site (Admin API `signin_urls`). */
  async signinUrl(memberId: string): Promise<string> {
    const r = await this.call<{ member_signin_urls: Array<{ url: string }> }>('GET', `/members/${memberId}/signin_urls/`);
    const url = r.member_signin_urls?.[0]?.url;
    if (!url) throw new Error('Ghost returned no sign-in URL');
    return url;
  }

  /** Ask Ghost to email an existing member a sign-in link (the Members API, as the sign-in form does). */
  async sendSigninEmail(email: string): Promise<void> {
    const base = this.cfg.ghostInternalUrl;
    const integrity = await fetch(`${base}/members/api/integrity-token/`, { headers: { Origin: this.cfg.ghostUrl } });
    const integrityToken = integrity.ok ? (await integrity.text()).trim() : undefined;
    const res = await fetch(`${base}/members/api/send-magic-link/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: this.cfg.ghostUrl, Referer: `${this.cfg.ghostUrl}/` },
      body: JSON.stringify({ email, emailType: 'signin', ...(integrityToken ? { integrityToken } : {}) }),
    });
    if (!res.ok) throw new Error(`Ghost send-magic-link: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}
