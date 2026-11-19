/**
 * Who signed in, as the app will see them (ADR-005, decisions 4–6).
 */
import { query } from '../db/client.js';
import { fullHandle } from '../auth/utils.js';
import { getDidResolver } from '../identity/did-resolver.js';
import { resolveSignInHandle } from '../oauth/external-client.js';
import type { SignedInPerson } from './claims.js';

async function displayNameOf(did: string): Promise<string | null> {
  const r = await query<{ name: string | null }>(
    `SELECT record->>'displayName' AS name FROM records_index
     WHERE community_did = $1 AND collection = 'app.bsky.actor.profile' AND rkey = 'self' LIMIT 1`,
    [did],
  );
  const name = r.rows[0]?.name?.trim();
  return name ? name.slice(0, 100) : null;
}

/** An account of this server, signed in with its password. */
export async function localPerson(user: { did: string; handle: string; email: string | null; emailVerified: boolean }): Promise<SignedInPerson> {
  return {
    did: user.did,
    handle: fullHandle(user.handle),
    displayName: await displayNameOf(user.did),
    email: user.email,
    emailVerified: user.emailVerified,
  };
}

/**
 * An account of another server, signed in at its own PDS. Its handle is
 * taken from its DID document and given only when it resolves back to the
 * same DID (the usual two-way check). The email is the one that server shared
 * for this sign-in (`transition:email`, #461), if any.
 */
export async function remotePerson(
  did: string,
  sharedEmail: { email: string; emailVerified: boolean } | null = null,
): Promise<SignedInPerson> {
  let handle: string | null = null;
  try {
    const doc = await getDidResolver().resolve(did);
    const aka = doc?.alsoKnownAs?.find((a) => a.startsWith('at://'));
    const candidate = aka ? aka.slice('at://'.length).toLowerCase() : null;
    if (candidate && (await resolveSignInHandle(candidate)) === did) handle = candidate;
  } catch {
    handle = null;
  }
  return {
    did,
    handle,
    displayName: null,
    email: sharedEmail?.email ?? null,
    emailVerified: sharedEmail ? sharedEmail.emailVerified : false,
  };
}

/** Is this DID a member of the community (the authority is the community's member record)? */
export async function isCommunityMember(communityDid: string, did: string): Promise<boolean> {
  const r = await query('SELECT 1 FROM members_unique WHERE community_did = $1 AND member_did = $2', [communityDid, did]);
  return r.rows.length > 0;
}

export async function communityName(communityDid: string): Promise<string> {
  const r = await query<{ handle: string; name: string | null }>(
    `SELECT c.handle, p.record->>'displayName' AS name FROM communities c
     LEFT JOIN records_index p ON p.community_did = c.did AND p.collection = 'net.openfederation.community.profile'
     WHERE c.did = $1 LIMIT 1`,
    [communityDid],
  );
  const row = r.rows[0];
  return row?.name || (row ? fullHandle(row.handle) : communityDid);
}
