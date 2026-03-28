export interface PDSSession {
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle: string;
}

export interface CommunityMember {
  did: string;
  handle: string;
  role?: string;
  roleRkey?: string;
}

export interface RoleRecord {
  rkey: string;
  name: string;
  permissions: string[];
}

export class PDSClient {
  private baseUrl: string;
  private session: PDSSession | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async fetch(path: string, opts: RequestInit = {}): Promise<any> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      ...opts,
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`PDS ${resp.status}: ${body}`);
    }
    return resp.json();
  }

  private authHeaders(): Record<string, string> {
    if (!this.session) throw new Error('Not authenticated');
    return { Authorization: `Bearer ${this.session.accessJwt}` };
  }

  async login(handle: string, password: string): Promise<void> {
    this.session = await this.fetch('/xrpc/com.atproto.server.createSession', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: handle, password }),
    });
    console.log(`[PDS] Logged in as ${this.session!.handle} (${this.session!.did})`);
  }

  async listMembers(communityDid: string): Promise<CommunityMember[]> {
    const result = await this.fetch(
      `/xrpc/net.openfederation.community.listMembers?communityDid=${encodeURIComponent(communityDid)}`,
      { headers: { ...this.authHeaders(), Accept: 'application/json' } }
    );
    return result.members || [];
  }

  async listRoles(communityDid: string): Promise<RoleRecord[]> {
    const result = await this.fetch(
      `/xrpc/net.openfederation.community.listRoles?communityDid=${encodeURIComponent(communityDid)}`,
      { headers: { Accept: 'application/json' } }
    );
    return result.roles || [];
  }

  async getProfile(did: string): Promise<any> {
    try {
      return await this.fetch(
        `/xrpc/net.openfederation.account.getProfile?did=${encodeURIComponent(did)}`,
        { headers: { Accept: 'application/json' } }
      );
    } catch {
      return null;
    }
  }
}
