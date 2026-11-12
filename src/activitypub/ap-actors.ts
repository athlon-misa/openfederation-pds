/**
 * ActivityPub Actor Document Builder
 *
 * Generates minimal AP Group actors for communities that have linked
 * ActivityPub-compatible applications. These actors are discovery-only: the
 * PDS doesn't process AP messages. They still name an inbox and an outbox,
 * because ActivityPub §4.1 requires both and Mastodon drops an actor without
 * an inbox; both are always-empty collections (see ap-routes.ts).
 */

export interface CommunityInfo {
  did: string;
  handle: string;
  display_name?: string;
  description?: string;
  created_at: string;
}

export interface ApplicationRecord {
  appType: string;
  instanceUrl: string;
  displayName?: string;
}

/**
 * The community's human-readable page, for the actor's `url` and the
 * WebFinger profile-page link. That page is the web UI's, not the PDS's (the
 * PDS serves no `/communities/...` page), so with no WEB_UI_URL there is no
 * page to point at and the link is left out rather than sent to a 404.
 */
export function communityProfileUrl(webUiUrl: string, did: string): string | undefined {
  const base = webUiUrl.trim().replace(/\/+$/, '');
  return base ? `${base}/communities/${did}` : undefined;
}

export function buildCommunityActor(
  community: CommunityInfo,
  applications: ApplicationRecord[],
  serviceUrl: string,
  publicKeyPem: string,
  profileUrl?: string,
) {
  const actorId = `${serviceUrl}/ap/actor/${community.did}`;

  return {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1',
      // PropertyValue is schema.org's, not ActivityStreams'. Without these
      // terms a JSON-LD consumer (Fedify and everything built on it) reads
      // the attachments as undefined `_:` terms and drops them. Same terms
      // Mastodon declares for its profile fields.
      {
        schema: 'http://schema.org#',
        PropertyValue: 'schema:PropertyValue',
        value: 'schema:value',
      },
    ],
    type: 'Group',
    id: actorId,
    name: community.display_name || community.handle,
    preferredUsername: community.handle,
    ...(profileUrl ? { url: profileUrl } : {}),
    summary: community.description || '',
    published: community.created_at,
    inbox: `${actorId}/inbox`,
    outbox: `${actorId}/outbox`,
    endpoints: {},
    attachment: applications.map((app) => ({
      type: 'PropertyValue',
      name: app.appType,
      value: `<a href="${escapeHtml(app.instanceUrl)}">${escapeHtml(app.displayName || app.instanceUrl)}</a>`,
    })),
    publicKey: {
      id: `${actorId}#main-key`,
      owner: actorId,
      publicKeyPem,
    },
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
