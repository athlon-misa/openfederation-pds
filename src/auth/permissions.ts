/**
 * Community permission strings.
 * Pattern: community.<collection-short>.<action>
 */
export const PERMISSIONS = {
  SETTINGS_WRITE: 'community.settings.write',
  PROFILE_WRITE: 'community.profile.write',
  MEMBER_READ: 'community.member.read',
  MEMBER_WRITE: 'community.member.write',
  MEMBER_DELETE: 'community.member.delete',
  ROLE_READ: 'community.role.read',
  ROLE_WRITE: 'community.role.write',
  ATTESTATION_WRITE: 'community.attestation.write',
  ATTESTATION_DELETE: 'community.attestation.delete',
  APPLICATION_WRITE: 'community.application.write',
  APPLICATION_DELETE: 'community.application.delete',
  GOVERNANCE_WRITE: 'community.governance.write',
  FORUM_WRITE: 'community.forum.write',
  FORUM_MODERATE: 'community.forum.moderate',
  CALENDAR_WRITE: 'community.calendar.write',
} as const;

export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/** Permissions that cannot be removed from the owner role (prevents lockout) */
export const OWNER_REQUIRED_PERMISSIONS: Permission[] = [
  PERMISSIONS.ROLE_WRITE,
  PERMISSIONS.SETTINGS_WRITE,
];

export interface RoleRecord {
  name: string;
  description?: string;
  permissions: string[];
  /**
   * Which kinds of attestation holders of this role may issue and revoke,
   * given they hold the attestation permissions at all. Absent means every
   * kind. This is the community's issuance policy: it lives on the role, so
   * it changes the way roles change (by proposal, in a community that
   * decides by vote), while issuing within it is routine.
   */
  attestationTypes?: string[];
}

/** The kinds of attestation a community can issue. */
export const ATTESTATION_TYPES = ['membership', 'role', 'credential'] as const;

/**
 * Check an `attestationTypes` value from a request. Returns an error message,
 * or null when it is acceptable (`undefined` / `null` mean "no restriction").
 */
export function invalidAttestationTypes(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) {
    return 'attestationTypes must be a non-empty list, or omitted to allow every type';
  }
  const unknown = value.filter((t) => !(ATTESTATION_TYPES as readonly unknown[]).includes(t));
  if (unknown.length > 0) {
    return `attestationTypes may only contain: ${ATTESTATION_TYPES.join(', ')}`;
  }
  return null;
}

export const ROLE_COLLECTION = 'net.openfederation.community.role';
export const MEMBER_COLLECTION = 'net.openfederation.community.member';

/**
 * Default role definitions created for every new community.
 */
export function getDefaultRoleRecords(): Array<{ name: string; record: RoleRecord }> {
  return [
    {
      name: 'owner',
      record: {
        name: 'owner',
        description: 'Community owner with full permissions',
        permissions: [...ALL_PERMISSIONS],
      },
    },
    {
      name: 'moderator',
      record: {
        name: 'moderator',
        description: 'Community moderator',
        permissions: [
          PERMISSIONS.PROFILE_WRITE,
          PERMISSIONS.MEMBER_READ,
          PERMISSIONS.MEMBER_WRITE,
          PERMISSIONS.MEMBER_DELETE,
          PERMISSIONS.ROLE_READ,
          PERMISSIONS.ATTESTATION_WRITE,
          PERMISSIONS.ATTESTATION_DELETE,
          PERMISSIONS.GOVERNANCE_WRITE,
          PERMISSIONS.FORUM_WRITE,
          PERMISSIONS.FORUM_MODERATE,
          PERMISSIONS.CALENDAR_WRITE,
        ],
      },
    },
    {
      name: 'member',
      record: {
        name: 'member',
        description: 'Regular community member',
        permissions: [
          PERMISSIONS.MEMBER_READ,
          PERMISSIONS.ROLE_READ,
          PERMISSIONS.FORUM_WRITE,
          PERMISSIONS.CALENDAR_WRITE,
        ],
      },
    },
  ];
}

/**
 * Find the rkey for a default role by name in a community's records.
 */
export async function findRoleRkeyByName(
  communityDid: string,
  roleName: string,
  queryFn: (sql: string, params: any[]) => Promise<{ rows: any[] }>
): Promise<string | null> {
  const result = await queryFn(
    `SELECT rkey FROM records_index
     WHERE community_did = $1 AND collection = $2 AND record->>'name' = $3
     LIMIT 1`,
    [communityDid, ROLE_COLLECTION, roleName]
  );
  return result.rows[0]?.rkey || null;
}
