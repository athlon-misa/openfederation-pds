import { PERMISSIONS } from '../auth/permissions.js';
import type { AuthContext } from '../auth/types.js';
import { getCallerCommunityCapabilities } from '../community/visibility.js';
import { HttpError } from '../xrpc/errors.js';
import { communityWriteRefusal } from '../auth/guards.js';

type CollectionMutationOperation = 'create' | 'update' | 'delete';

type OperationPermissions = Record<CollectionMutationOperation, string>;

interface CollectionMutationPolicy {
  permissions: OperationPermissions;
  requiresDedicatedEndpoint?: boolean;
}

const PROTECTED_COLLECTION_POLICIES: Record<string, CollectionMutationPolicy> = {
  'net.openfederation.community.settings': {
    permissions: {
      create: PERMISSIONS.SETTINGS_WRITE,
      update: PERMISSIONS.SETTINGS_WRITE,
      delete: PERMISSIONS.SETTINGS_WRITE,
    },
    requiresDedicatedEndpoint: true,
  },
  'net.openfederation.community.profile': {
    permissions: {
      create: PERMISSIONS.PROFILE_WRITE,
      update: PERMISSIONS.PROFILE_WRITE,
      delete: PERMISSIONS.PROFILE_WRITE,
    },
    requiresDedicatedEndpoint: true,
  },
  'net.openfederation.community.member': {
    permissions: {
      create: PERMISSIONS.MEMBER_WRITE,
      update: PERMISSIONS.MEMBER_WRITE,
      delete: PERMISSIONS.MEMBER_DELETE,
    },
    requiresDedicatedEndpoint: true,
  },
  'net.openfederation.community.role': {
    permissions: {
      create: PERMISSIONS.ROLE_WRITE,
      update: PERMISSIONS.ROLE_WRITE,
      delete: PERMISSIONS.ROLE_WRITE,
    },
    requiresDedicatedEndpoint: true,
  },
  'net.openfederation.community.attestation': {
    permissions: {
      create: PERMISSIONS.ATTESTATION_WRITE,
      update: PERMISSIONS.ATTESTATION_WRITE,
      delete: PERMISSIONS.ATTESTATION_DELETE,
    },
    requiresDedicatedEndpoint: true,
  },
  'net.openfederation.community.application': {
    permissions: {
      create: PERMISSIONS.APPLICATION_WRITE,
      update: PERMISSIONS.APPLICATION_WRITE,
      delete: PERMISSIONS.APPLICATION_DELETE,
    },
    requiresDedicatedEndpoint: true,
  },
  'net.openfederation.community.proposal': {
    permissions: {
      create: PERMISSIONS.GOVERNANCE_WRITE,
      update: PERMISSIONS.GOVERNANCE_WRITE,
      delete: PERMISSIONS.GOVERNANCE_WRITE,
    },
    requiresDedicatedEndpoint: true,
  },
  'net.openfederation.governance.decision': {
    permissions: {
      create: PERMISSIONS.GOVERNANCE_WRITE,
      update: PERMISSIONS.GOVERNANCE_WRITE,
      delete: PERMISSIONS.GOVERNANCE_WRITE,
    },
    requiresDedicatedEndpoint: true,
  },
  'net.openfederation.community.delegation': {
    permissions: {
      create: PERMISSIONS.GOVERNANCE_WRITE,
      update: PERMISSIONS.GOVERNANCE_WRITE,
      delete: PERMISSIONS.GOVERNANCE_WRITE,
    },
    requiresDedicatedEndpoint: true,
  },
};

/**
 * Collections that live in ordinary user repositories but are only ever written
 * by the PDS on the user's behalf through a dedicated endpoint. Self-writes to
 * these are refused so the records keep their meaning as attestations produced
 * by a governed flow rather than arbitrary user-authored claims.
 */
const SELF_REPO_DEDICATED_ENDPOINT_COLLECTIONS = new Set<string>([
  'net.openfederation.governance.vote',
  // An objection holds a community's decided change, and it counts because the
  // objector was eligible to vote and raised it inside the window. Both facts
  // are established by `objectToProposal`; a hand-written record in one's own
  // repo would assert them instead.
  'net.openfederation.governance.objection',
  // A decision belongs to the community repo that resolved the proposal, and
  // `verifyDecision` refuses one found anywhere else. But the offline CLI scans
  // every supplied export for decision records, so a self-written decision in a
  // voter's repo would make `--decision <rkey>` mandatory on every verification
  // of a proposal that voter took part in — griefing the verification path
  // rather than the outcome. Refused at the source.
  'net.openfederation.governance.decision',
]);

/**
 * Collections in a user's own repo whose records are claims the PDS has
 * checked, so they are written only by the endpoint that does the checking.
 *
 * An external key record says "this DID controls this key". `setExternalKey`
 * requires a signature from the key and refuses a key another DID already
 * holds; a record written directly would assert control of anyone's key, be
 * returned by `resolveByKey`, and block the real holder from claiming it.
 */
const SELF_REPO_VERIFIED_CLAIM_COLLECTIONS = new Set<string>([
  'net.openfederation.identity.externalKey',
]);

const FALLBACK_PERMISSIONS: OperationPermissions = {
  create: PERMISSIONS.MEMBER_WRITE,
  update: PERMISSIONS.MEMBER_WRITE,
  delete: PERMISSIONS.MEMBER_DELETE,
};

/**
 * Apply collection-specific authorization to a generic ATProto mutation.
 *
 * Self-writes to ordinary user repositories remain ATProto-compatible.
 * Mutations against community repositories use the same permission names as
 * their dedicated endpoints, while unrecognized collections retain the
 * existing generic community write/delete permissions.
 */
export async function authorizeCollectionMutation(input: {
  actor: AuthContext;
  repo: string;
  collection: string;
  operation: CollectionMutationOperation;
}): Promise<void> {
  const capabilities = await getCallerCommunityCapabilities({
    communityDid: input.repo,
    caller: input.actor,
  });

  if (!capabilities.exists) {
    if (input.repo === input.actor.did) {
      if (
        SELF_REPO_DEDICATED_ENDPOINT_COLLECTIONS.has(input.collection)
        || SELF_REPO_VERIFIED_CLAIM_COLLECTIONS.has(input.collection)
      ) {
        throw new HttpError(
          400,
          'UseDedicatedEndpoint',
          `Records in "${input.collection}" must be mutated through their dedicated endpoint`,
        );
      }
      return;
    }
    throw new HttpError(403, 'Forbidden', 'Cannot mutate another repository');
  }

  // A frozen, moved or still-arriving community takes no writes by this route
  // either; the dedicated endpoints refuse through the same rule.
  const refusal = communityWriteRefusal(capabilities.status);
  if (refusal) throw new HttpError(refusal.status, refusal.error, refusal.message);

  // Votes and objections count for the repo they sit in, and a decision is
  // what the community's own resolution writes. None of them may be
  // hand-written into a community repo: a member with write access could
  // otherwise make the community itself an extra voter or objector.
  if (SELF_REPO_DEDICATED_ENDPOINT_COLLECTIONS.has(input.collection)) {
    throw new HttpError(
      400,
      'UseDedicatedEndpoint',
      `Records in "${input.collection}" must be mutated through their dedicated endpoint`,
    );
  }

  const policy = PROTECTED_COLLECTION_POLICIES[input.collection];
  const requiredPermission =
    (policy?.permissions ?? FALLBACK_PERMISSIONS)[input.operation];

  if (
    capabilities.hasAllPermissions
    || capabilities.permissions.includes(requiredPermission)
  ) {
    if (policy?.requiresDedicatedEndpoint) {
      throw new HttpError(
        400,
        'UseDedicatedEndpoint',
        `Records in "${input.collection}" must be mutated through their dedicated endpoint`,
      );
    }
    return;
  }

  throw new HttpError(403, 'Forbidden', 'Insufficient community privileges');
}
