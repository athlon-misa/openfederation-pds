export interface MatrixMember {
  userId: string;
  powerLevel: number;
}

export class MatrixClient {
  private homeserverUrl: string;
  private adminToken: string;

  constructor(homeserverUrl: string, adminToken: string) {
    this.homeserverUrl = homeserverUrl.replace(/\/+$/, '');
    this.adminToken = adminToken;
  }

  private async fetch(path: string, opts: RequestInit = {}): Promise<any> {
    const resp = await fetch(`${this.homeserverUrl}${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this.adminToken}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Matrix ${resp.status}: ${body}`);
    }
    return resp.json().catch(() => ({}));
  }

  async getSpaceMembers(spaceId: string): Promise<MatrixMember[]> {
    const state = await this.fetch(
      `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.power_levels/`
    );
    const powerLevels = state.users || {};
    const defaultLevel = state.users_default || 0;

    const membersResp = await this.fetch(
      `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/joined_members`
    );
    const joined = membersResp.joined || {};

    return Object.keys(joined).map(userId => ({
      userId,
      powerLevel: powerLevels[userId] ?? defaultLevel,
    }));
  }

  async inviteToSpace(spaceId: string, userId: string): Promise<void> {
    await this.fetch(
      `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/invite`,
      { method: 'POST', body: JSON.stringify({ user_id: userId }) }
    );
  }

  async kickFromSpace(spaceId: string, userId: string, reason?: string): Promise<void> {
    await this.fetch(
      `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/kick`,
      { method: 'POST', body: JSON.stringify({ user_id: userId, reason: reason || 'Removed from community' }) }
    );
  }

  async setPowerLevel(spaceId: string, userId: string, level: number): Promise<void> {
    const state = await this.fetch(
      `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.power_levels/`
    );
    state.users = state.users || {};
    state.users[userId] = level;

    await this.fetch(
      `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.room.power_levels/`,
      { method: 'PUT', body: JSON.stringify(state) }
    );
  }

  async registerUser(localpart: string, displayName?: string): Promise<string> {
    const hostname = new URL(this.homeserverUrl).hostname;
    const result = await this.fetch(
      `/_synapse/admin/v2/users/@${localpart}:${hostname}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          displayname: displayName || localpart,
          password: crypto.randomUUID(),
          admin: false,
          deactivated: false,
        }),
      }
    );
    return result.name || `@${localpart}:${hostname}`;
  }
}
