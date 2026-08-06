import { query } from '../db/client.js';
import { resolveAttestor, type GovernanceProof } from './attestor.js';
import type { GovernanceRequestContext } from './request-authority.js';
import { MANDATORY_PROTECTED_COLLECTIONS, SETTINGS_COLLECTION } from './settings-rules.js';

/** Collections that MUST always be protected — cannot be removed from governance */
const MANDATORY_PROTECTED = MANDATORY_PROTECTED_COLLECTIONS;

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
 * Optional request to consult a registered attestor while enforcing governance.
 * Callers only pass this when external verification is actually being requested
 * (e.g. an Oracle-submitted proof); when omitted, the attestor registry is never
 * touched, regardless of whether an attestor happens to be registered.
 */
export interface AttestationRequest {
  chainId: string;
  proof: GovernanceProof;
}

/**
 * Check if a write to a community repo is allowed under the current governance model.
 * Call AFTER permission checks but BEFORE engine.putRecord/deleteRecord.
 */
export async function enforceGovernance(
  communityDid: string,
  collection: string,
  action: 'write' | 'delete',
  requestContext?: GovernanceRequestContext | null,
  attestation?: AttestationRequest,
): Promise<GovernanceResult> {
  // ── Attestor hook (single seam core has into the attestor registry) ──
  // Only consulted when a caller explicitly requests external verification.
  // If no attestor is registered for the requested chain, this is a no-op —
  // the path is skipped entirely. If the attestor throws, the failure is
  // swallowed: attestor availability/behavior never changes a governance
  // outcome in this task (later tasks may build on this hook's result).
  if (attestation) {
    const attestor = resolveAttestor(attestation.chainId);
    if (attestor) {
      try {
        await attestor.verifyProof(attestation.proof);
      } catch {
        // Never let attestor failures affect governance enforcement.
      }
    }
  }
  if (collection === SETTINGS_COLLECTION && action === 'delete') {
    return {
      allowed: false,
      reason: 'Community settings cannot be deleted',
    };
  }

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

    case 'on-chain': {
      // `on-chain` is `simple-majority` plus anchoring (#198): the community
      // decides in its own repos and a notary may witness the result. So the
      // fallback here is the proposal flow, exactly as for simple-majority —
      // there is always a route to a decision that needs no chain at all.
      //
      // An external authority (registered by a module) may additionally attest
      // that this request is authorized to act for the community, which is a
      // way of carrying delegated authority into a request rather than a way of
      // deciding anything. Core never learns what kind of authority it is.
      //
      // **That delegation stops at the settings record.** A service acting for
      // a community may act *under* the community's governance; it may not
      // change what that governance is. Without this exclusion the bypass would
      // be a full replacement for the ratchet this task removed — an Oracle
      // could rewrite `governanceModel` to `benevolent-dictator` and everything
      // protected would become directly writable, which would make `on-chain`
      // strictly weaker than `simple-majority` rather than equal to it plus a
      // notary. The community's own quorum is the only route to its own rules.
      const delegated = Boolean(requestContext && requestContext.communityDid === communityDid);
      if (delegated && collection !== SETTINGS_COLLECTION) {
        return { allowed: true, governanceModel };
      }
      return {
        allowed: false,
        requiresProposal: true,
        reason: delegated
          ? 'This community uses on-chain governance. An authorized service may act under the community\'s governance, but changes to its settings record — including the governance model itself — require a proposal and majority vote.'
          : 'This community uses on-chain governance. Changes to protected collections require a proposal and majority vote, or an authorized service request.',
        governanceModel,
      };
    }

    default:
      // An unrecognized model is not permission to do anything. Falling through
      // to `allowed: true` here would mean a settings record naming a model
      // nobody implements (a typo, a downgrade to an older PDS) silently left
      // every protected collection directly writable. `settings-rules.ts` stops
      // such a record being written; this is the backstop for the ones that
      // already exist.
      //
      // **Operator note — recovering such a community.** This state is closed
      // to the API by design: `setGovernanceModel` is refused (settings is
      // protected and this branch denies) and `createProposal` refuses with
      // `GovernanceNotActive`, so there is deliberately no endpoint that repairs
      // it. An escape hatch here would be exactly the admin override #198
      // removed — a PDS operator deciding a community's governance — so the
      // repair is an explicit, audited, out-of-band act instead: write a valid
      // `net.openfederation.community.settings` record for the community with
      // its own signing key (`RepoEngine(did).putRecord(await
      // getKeypairForDid(did), 'net.openfederation.community.settings', 'self',
      // { ...settings, governanceModel: 'benevolent-dictator' })`), after which
      // the normal routes work again. No API path can create this state: all
      // three write paths validate through `checkGovernanceSettings`, and raw
      // `putRecord` to the settings collection is refused by
      // `collection-policy.ts`. Only pre-existing or out-of-band records reach
      // here.
      return {
        allowed: false,
        requiresProposal: true,
        reason: `This community's settings record names an unrecognized governance model "${governanceModel}". Changes to protected collections are refused until it names a known model.`,
        governanceModel,
      };
  }
}

/**
 * Check if a DID belongs to a community (has an entry in the communities table).
 */
export async function isCommunityDid(did: string): Promise<boolean> {
  const result = await query('SELECT 1 FROM communities WHERE did = $1', [did]);
  return result.rows.length > 0;
}
