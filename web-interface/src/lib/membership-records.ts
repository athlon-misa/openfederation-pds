/**
 * Membership records in members' own repos (#385), as the community settings
 * page explains them when a community is made private. A member's repo is
 * public: the server removes the records it holds, but not the ones on other
 * servers or the ones a member's device signs.
 */

export interface MembershipRecordsRemoval {
  removed: number;
  keptOnDevice: number;
  elsewhere: number;
}

export const PRIVATE_SWITCH_WARNING =
  'Members keep a public record of the communities they belong to in their own account. '
  + 'Making this community private removes those records from accounts on this server. '
  + 'Members with accounts on other servers keep theirs until they delete them: this server cannot remove them.';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What to tell the owner after saving, or null when every record is gone. */
export function membershipRecordsNotice(r: MembershipRecordsRemoval | undefined): string | null {
  if (!r) return null;
  const parts: string[] = [];
  if (r.elsewhere > 0) {
    parts.push(`${plural(r.elsewhere, 'member has an account', 'members have accounts')} on ${r.elsewhere === 1 ? 'another server' : 'other servers'}. `
      + 'Their public record of belonging to this community stays until they delete it.');
  }
  if (r.keptOnDevice > 0) {
    parts.push(`${plural(r.keptOnDevice, 'member signs', 'members sign')} their records on their own device; only they can remove theirs.`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
