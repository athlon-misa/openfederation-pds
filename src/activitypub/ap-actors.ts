/**
 * ActivityPub Actor Document Builder
 *
 * Generates minimal AP Group actors for communities that have linked
 * ActivityPub-compatible applications. These actors are discovery-only
 * (no inbox/outbox) — the PDS doesn't process AP messages.
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

export function buildCommunityActor(
  community: CommunityInfo,
  applications: ApplicationRecord[],
  serviceUrl: string,
  publicKeyPem: string,
) {
  const actorId = `${serviceUrl}/ap/actor/${community.did}`;

  return {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1',
    ],
    type: 'Group',
    id: actorId,
    name: community.display_name || community.handle,
    preferredUsername: community.handle,
    url: `${serviceUrl}/communities/${community.did}`,
    summary: community.description || '',
    published: community.created_at,
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
