import { query } from '../db/client.js';

/** Collections protected under governance modes */
const PROTECTED_COLLECTIONS = [
  'net.openfederation.community.settings',
  'net.openfederation.community.role',
  'net.openfederation.community.member',
  'net.openfederation.community.profile',
  'net.openfederation.community.attestation',
];

/** Member operations exempt from governance (operational, not policy) */
const EXEMPT_OPERATIONS = [
  { collection: 'net.openfederation.community.member', exemptActions: ['write', 'delete'] as const },
];

export interface GovernanceResult {
  allowed: boolean;
  reason?: string;
  requiresProposal?: boolean;
  governanceModel?: string;
}

/**
 * Check if a write to a community repo is allowed under the current governance model.
 * Call AFTER permission checks but BEFORE engine.putRecord/deleteRecord.
 */
export async function enforceGovernance(
  communityDid: string,
  collection: string,
  action: 'write' | 'delete',
): Promise<GovernanceResult> {
  if (!PROTECTED_COLLECTIONS.includes(collection)) {
    return { allowed: true };
  }

  const exempt = EXEMPT_OPERATIONS.find(e => e.collection === collection);
  if (exempt && (exempt.exemptActions as readonly string[]).includes(action)) {
    return { allowed: true };
  }

  const settingsResult = await query<{ record: { governanceModel?: string } }>(
    `SELECT record FROM records_index
     WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
    [communityDid]
  );

  const governanceModel = settingsResult.rows[0]?.record?.governanceModel || 'benevolent-dictator';

  switch (governanceModel) {
    case 'benevolent-dictator':
      return { allowed: true, governanceModel };

    case 'simple-majority':
      return {
        allowed: false,
        requiresProposal: true,
        reason: 'This community uses simple-majority governance. Changes to protected collections require a proposal and majority vote.',
        governanceModel,
      };

    case 'on-chain':
      return {
        allowed: false,
        reason: 'GovernanceRequired: on-chain governance is active. Writes to protected collections must come via an authorized Oracle service.',
        governanceModel,
      };

    default:
      return { allowed: true, governanceModel };
  }
}

/**
 * Check if a DID belongs to a community (has an entry in the communities table).
 */
export async function isCommunityDid(did: string): Promise<boolean> {
  const result = await query('SELECT 1 FROM communities WHERE did = $1', [did]);
  return result.rows.length > 0;
}
