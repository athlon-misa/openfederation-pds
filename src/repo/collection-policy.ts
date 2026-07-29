import { PERMISSIONS } from '../auth/permissions.js';
import type { AuthContext } from '../auth/types.js';
import { getCallerCommunityCapabilities } from '../community/visibility.js';
import { HttpError } from '../xrpc/errors.js';

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
  'net.openfederation.community.delegation': {
    permissions: {
      create: PERMISSIONS.GOVERNANCE_WRITE,
      update: PERMISSIONS.GOVERNANCE_WRITE,
      delete: PERMISSIONS.GOVERNANCE_WRITE,
    },
    requiresDedicatedEndpoint: true,
  },
};

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
    if (input.repo === input.actor.did) return;
    throw new HttpError(403, 'Forbidden', 'Cannot mutate another repository');
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
