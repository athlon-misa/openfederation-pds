import { PDSClient, CommunityMember } from './pds-client.js';
import { MatrixClient } from './matrix-client.js';
import { CommunityMapping, BridgeConfig } from './config.js';

export class SyncEngine {
  private pds: PDSClient;
  private matrix: MatrixClient;
  private config: BridgeConfig;

  constructor(pds: PDSClient, matrix: MatrixClient, config: BridgeConfig) {
    this.pds = pds;
    this.matrix = matrix;
    this.config = config;
  }

  async syncCommunity(mapping: CommunityMapping): Promise<void> {
    const { communityDid, matrixSpaceId, rolePowerLevels } = mapping;

    console.log(`[Sync] Syncing ${communityDid} -> ${matrixSpaceId}`);

    const pdsMembers = await this.pds.listMembers(communityDid);
    const pdsRoles = await this.pds.listRoles(communityDid);
    const roleMap = new Map(pdsRoles.map(r => [r.rkey, r.name]));

    const pdsUserMap = new Map<string, { member: CommunityMember; matrixId: string | null; roleName: string }>();

    for (const member of pdsMembers) {
      const matrixId = await this.resolveMatrixId(member);
      const roleName = member.roleRkey ? (roleMap.get(member.roleRkey) || 'member') : (member.role || 'member');
      pdsUserMap.set(member.did, { member, matrixId, roleName });
    }

    const matrixMembers = await this.matrix.getSpaceMembers(matrixSpaceId);
    const matrixUserIds = new Set(matrixMembers.map(m => m.userId));

    let invited = 0, kicked = 0, updated = 0;

    for (const [, { matrixId, roleName }] of pdsUserMap) {
      if (!matrixId) continue;

      const powerLevel = rolePowerLevels[roleName] ?? rolePowerLevels['member'] ?? 0;

      if (!matrixUserIds.has(matrixId)) {
        try {
          await this.matrix.inviteToSpace(matrixSpaceId, matrixId);
          await this.matrix.setPowerLevel(matrixSpaceId, matrixId, powerLevel);
          invited++;
        } catch (err) {
          console.error(`[Sync] Failed to invite ${matrixId}:`, err);
        }
      } else {
        const current = matrixMembers.find(m => m.userId === matrixId);
        if (current && current.powerLevel !== powerLevel) {
          try {
            await this.matrix.setPowerLevel(matrixSpaceId, matrixId, powerLevel);
            updated++;
          } catch (err) {
            console.error(`[Sync] Failed to update power level for ${matrixId}:`, err);
          }
        }
      }
    }

    const pdsMatrixIds = new Set(
      [...pdsUserMap.values()].map(v => v.matrixId).filter(Boolean)
    );
    for (const matrixMember of matrixMembers) {
      if (matrixMember.powerLevel >= 100) continue;

      if (!pdsMatrixIds.has(matrixMember.userId)) {
        try {
          await this.matrix.kickFromSpace(matrixSpaceId, matrixMember.userId, 'No longer a community member');
          kicked++;
        } catch (err) {
          console.error(`[Sync] Failed to kick ${matrixMember.userId}:`, err);
        }
      }
    }

    console.log(`[Sync] ${communityDid}: invited=${invited} kicked=${kicked} updated=${updated}`);
  }

  private async resolveMatrixId(member: CommunityMember): Promise<string | null> {
    if (this.config.mode === 'public') {
      const profile = await this.pds.getProfile(member.did);
      const matrixProfile = profile?.customProfiles?.['app.matrix.actor.profile'];
      return matrixProfile?.matrixId || null;
    } else {
      const template = this.config.matrix.handleTemplate || '{handle}:localhost';
      const localpart = member.handle.replace(/[^a-z0-9._=-]/gi, '_').toLowerCase();
      const matrixId = `@${template.replace('{handle}', localpart)}`;
      return matrixId;
    }
  }

  async syncAll(): Promise<void> {
    for (const mapping of this.config.communityMappings) {
      try {
        await this.syncCommunity(mapping);
      } catch (err) {
        console.error(`[Sync] Error syncing ${mapping.communityDid}:`, err);
      }
    }
  }
}
