/**
 * The single answer to "may this community be shown to the outside?" (#85).
 *
 * Private communities are PDS-local: their records, member lists, profile
 * content and repo bytes do not leave this server's membership-gated
 * endpoints. That posture (ADR-001) is only as strong as its weakest public
 * surface, and the failure mode that motivated this module was exactly a
 * surface nobody re-checked — the ActivityPub actor route served a private
 * community's display name, description and linked application instances to
 * anyone holding the DID, which the public PLC directory hands out.
 *
 * So the predicate lives in ONE place, and every surface that exposes
 * community data to unauthenticated or external callers answers to it:
 *
 *   com.atproto.sync.getRepo / repo.*   requireRepoReadable (guards.ts)
 *   community read endpoints            requireCommunityReadable / per-handler
 *   community.listAll                   hard-filtered to public in SQL
 *   federation peer exchange            peers request visibility=public
 *   /.well-known/webfinger              federationView() — existence visible,
 *   /ap/actor/:did                      content stripped (ADR-001 §discovery)
 *
 * **If you are adding a firehose, subscribeRepos, listRepos, a relay
 * announcement, or any other bulk/event surface: it MUST consult this
 * module and exclude every DID whose view is 'private'.** A private
 * community's commits do not enter an event stream — an encrypted-repo
 * design (issue #85, option 3) is the only thing that could relax this, and
 * it does not exist.
 *
 * What is deliberately NOT protected, and cannot be: for did:plc communities
 * the DID's existence and handle live in the public PLC directory by design.
 * Hiding them here would be theater. What is protected is everything past
 * existence — content, membership, records, presence details.
 */
import { query } from '../db/client.js';

export type FederationView =
  /** Fully public: federates, discoverable, content served. */
  | 'public'
  /** Exists (PLC already says so) but content is PDS-local. */
  | 'private'
  /** Not a community this PDS hosts, or not active. */
  | 'absent';

export async function communityFederationView(did: string): Promise<FederationView> {
  const result = await query<{ status: string; visibility: string | null }>(
    `SELECT c.status, s.record->>'visibility' AS visibility
     FROM communities c
     LEFT JOIN records_index s
       ON s.community_did = c.did
      AND s.collection = 'net.openfederation.community.settings'
      AND s.rkey = 'self'
     WHERE c.did = $1`,
    [did],
  );
  if (result.rows.length === 0 || result.rows[0].status !== 'active') return 'absent';
  return (result.rows[0].visibility || 'public') === 'public' ? 'public' : 'private';
}
