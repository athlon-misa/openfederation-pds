import { query } from '../db/client.js';
import type { OracleContext } from '../auth/oracle-guard.js';

/** Collections that MUST always be protected — cannot be removed from governance */
const MANDATORY_PROTECTED = [
  'net.openfederation.community.settings',
  'net.openfederation.community.role',
];

/** Default protected collections when no custom config is set */
const DEFAULT_PROTECTED = [
  ...MANDATORY_PROTECTED,
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
  oracleContext?: OracleContext | null,
): Promise<GovernanceResult> {
  // Fetch settings once (used for both protection check and governance model)
  const settingsResult = await query<{ record: any }>(
    `SELECT record FROM records_index
     WHERE community_did = $1 AND collection = 'net.openfederation.community.settings' AND rkey = 'self'`,
    [communityDid]
  );

  const settings = settingsResult.rows[0]?.record;
  const govConfig = settings?.governanceConfig;

  // Determine protected collections (per-community config or defaults)
  const configProtected: string[] | undefined = govConfig?.protectedCollections;
  const protectedCollections = configProtected?.length
    ? [...new Set([
        ...MANDATORY_PROTECTED,
        ...configProtected.map((c: string) =>
          c.startsWith('net.openfederation.community.') ? c : `net.openfederation.community.${c}`
        ),
      ])]
    : DEFAULT_PROTECTED;

  if (!protectedCollections.includes(collection)) {
    return { allowed: true };
  }

  // Check exempt operations
  const exempt = EXEMPT_OPERATIONS.find(e => e.collection === collection);
  if (exempt && (exempt.exemptActions as readonly string[]).includes(action)) {
    return { allowed: true };
  }

  const governanceModel = settings?.governanceModel || 'benevolent-dictator';

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
      if (oracleContext && oracleContext.communityDid === communityDid) {
        return { allowed: true, governanceModel };
      }
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
