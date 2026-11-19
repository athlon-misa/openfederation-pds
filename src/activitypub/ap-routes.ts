/**
 * ActivityPub Routes
 *
 * Express router for AP-compatible discovery endpoints:
 * - GET /ap/actor/:did — AP Group actor document for communities with linked apps
 * - GET /.well-known/nodeinfo — NodeInfo discovery
 * - GET /nodeinfo/2.1 — NodeInfo 2.1 document
 */

import express, { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { config } from '../config.js';
import { query } from '../db/client.js';
import { communityFederationView } from '../federation/privacy.js';
import { encryptKeyBytes, decryptKeyBytes } from '../auth/encryption.js';
import { buildCommunityActor, communityProfileUrl, type ApplicationRecord } from './ap-actors.js';
import { SERVER_VERSION } from '../server/server-version.js';
import { handleInboxDelivery, deliverAccept } from './follows.js';

const router = Router();

// Enabled is re-checked per request rather than at mount time, exactly like
// the chain module: the router is always mounted, so tests can reach it and
// an operator can flip ACTIVITYPUB_ENABLED without a rebuild — and a
// disabled instance answers 404 for every AP route, not just unmounted
// silence in production and different behaviour under test. That mount-time
// gating is also how the private-community leak (#85) survived: the routes
// were unreachable from the test harness, so nothing could pin them.
router.use((req, res, next) => {
  if (!config.activitypub.enabled) {
    next('router');
    return;
  }
  next();
});

// In-memory cache for RSA key pairs per community DID (performance — avoids repeated DB lookups)
const rsaKeyCache = new Map<string, { publicKey: string; privateKey: string }>();

/** Forget the decrypted AP keys (the demo reset, src/server/fresh-start.ts). */
export function clearApKeyCache(): void {
  rsaKeyCache.clear();
}

/**
 * Get or create a persisted RSA keypair for AP actor HTTP signatures.
 * AP ecosystem (Mastodon, GoToSocial, etc.) requires RSA keys for HTTP signatures.
 * ATProto uses secp256k1, so we generate a separate RSA key for each community DID.
 * Keys are stored encrypted in the database and survive server restarts.
 */
async function getOrCreateApKeys(did: string): Promise<{ publicKey: string; privateKey: string }> {
  // Check in-memory cache first
  const cached = rsaKeyCache.get(did);
  if (cached) return cached;

  // Check database for existing persisted keys
  const result = await query<{ public_key_pem: string; encrypted_private_key: Buffer }>(
    'SELECT public_key_pem, encrypted_private_key FROM ap_signing_keys WHERE did = $1',
    [did],
  );

  if (result.rows.length > 0) {
    const row = result.rows[0];
    const privateKey = (await decryptKeyBytes(row.encrypted_private_key, 'activitypub.signing-key')).toString('utf-8');
    const keys = { publicKey: row.public_key_pem, privateKey };
    rsaKeyCache.set(did, keys);
    return keys;
  }

  // Generate a new RSA keypair and persist it
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Encrypt private key before storing
  const encryptedPrivateKey = await encryptKeyBytes(Buffer.from(privateKey, 'utf-8'), 'activitypub.signing-key');

  await query(
    'INSERT INTO ap_signing_keys (did, public_key_pem, encrypted_private_key) VALUES ($1, $2, $3) ON CONFLICT (did) DO NOTHING',
    [did, publicKey, encryptedPrivateKey],
  );

  const keys = { publicKey: publicKey as string, privateKey: privateKey as string };
  rsaKeyCache.set(did, keys);
  return keys;
}

type ActorLookup =
  | { found: false; status: number; error: string; message: string }
  | {
    found: true;
    community: { did: string; handle: string; created_at: string };
    federationView: Awaited<ReturnType<typeof communityFederationView>>;
    applications: ApplicationRecord[];
  };

/**
 * An actor exists for an active community with at least one linked
 * application. Shared by the actor document and its inbox/outbox, so the
 * collections exist exactly when the actor does.
 */
async function lookupActorCommunity(did: string): Promise<ActorLookup> {
  if (!did || !did.startsWith('did:')) {
    return { found: false, status: 400, error: 'BadRequest', message: 'Invalid DID format' };
  }

  const communityResult = await query<{
    did: string;
    handle: string;
    created_at: string;
    status: string;
  }>(
    'SELECT did, handle, created_at, status FROM communities WHERE did = $1',
    [did],
  );

  const communityRow = communityResult.rows[0];
  if (!communityRow || communityRow.status !== 'active') {
    return { found: false, status: 404, error: 'NotFound', message: 'Community not found' };
  }

  // A private community's actor exists — its DID and handle are in the
  // public PLC directory regardless, and the owner deliberately linked AP
  // applications that need to address and signature-verify it — but it is
  // served STRIPPED: no display name, no description, no linked-instance
  // attachments (#85, ADR-001). Existence is not the secret; content is.
  const federationView = await communityFederationView(did);

  // Load linked applications from records_index
  const appResult = await query<{
    rkey: string;
    record: { appType: string; instanceUrl: string; displayName?: string };
  }>(
    `SELECT rkey, record FROM records_index
     WHERE community_did = $1 AND collection = 'net.openfederation.community.application'
     ORDER BY rkey ASC`,
    [did],
  );

  if (appResult.rows.length === 0) {
    return { found: false, status: 404, error: 'NotFound', message: 'No linked applications for this community' };
  }

  return {
    found: true,
    community: communityRow,
    federationView,
    applications: appResult.rows.map((row) => ({
      appType: row.record.appType,
      instanceUrl: row.record.instanceUrl,
      displayName: row.record.displayName,
    })),
  };
}

/**
 * GET /ap/actor/:did
 * Returns an ActivityPub Group actor document for a community.
 * Only returns an actor if the community has linked AP applications.
 */
router.get('/ap/actor/:did', async (req: Request, res: Response) => {
  try {
    const did = req.params.did as string;
    const lookup = await lookupActorCommunity(did);
    if (!lookup.found) {
      res.status(lookup.status).json({ error: lookup.error, message: lookup.message });
      return;
    }
    const { community: communityRow, federationView } = lookup;

    // Load profile from repo records (display name, description are stored as records, not DB columns)
    const profileResult = federationView === 'public'
      ? await query<{
        record: { displayName?: string; description?: string };
      }>(
        `SELECT record FROM records_index
         WHERE community_did = $1 AND collection = 'net.openfederation.community.profile' LIMIT 1`,
        [did],
      )
      : { rows: [] as Array<{ record: { displayName?: string; description?: string } }> };
    const profile = profileResult.rows[0]?.record || {};

    // Which AP instances back this community is content, not addressing:
    // stripped from a private community's actor along with the profile.
    const applications: ApplicationRecord[] = federationView === 'public' ? lookup.applications : [];

    // Load or create persisted RSA keys for AP compatibility
    // (AP ecosystem uses RSA for HTTP signatures; ATProto uses secp256k1)
    const publicKeyPem = (await getOrCreateApKeys(did)).publicKey;

    const actor = buildCommunityActor(
      {
        did: communityRow.did,
        handle: communityRow.handle,
        display_name: profile.displayName || undefined,
        description: profile.description || undefined,
        created_at: communityRow.created_at,
      },
      applications,
      config.pds.serviceUrl,
      publicKeyPem,
      communityProfileUrl(config.federation.webUiUrl, communityRow.did),
    );

    res.setHeader('Content-Type', 'application/activity+json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(actor);
  } catch (err) {
    console.error('Error serving AP actor:', err);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to serve actor document' });
  }
});

/**
 * GET /ap/actor/:did/inbox and /ap/actor/:did/outbox
 *
 * The actor is discovery-only, so both collections are always empty. They
 * exist because ActivityPub requires an actor to name them and Mastodon drops
 * an actor without an inbox. Deliveries are handled below.
 */
for (const box of ['inbox', 'outbox'] as const) {
  router.get(`/ap/actor/:did/${box}`, async (req: Request, res: Response) => {
    try {
      const did = req.params.did as string;
      const lookup = await lookupActorCommunity(did);
      if (!lookup.found) {
        res.status(lookup.status).json({ error: lookup.error, message: lookup.message });
        return;
      }
      res.setHeader('Content-Type', 'application/activity+json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${config.pds.serviceUrl}/ap/actor/${did}/${box}`,
        type: 'OrderedCollection',
        totalItems: 0,
        orderedItems: [],
      });
    } catch (err) {
      console.error(`Error serving AP ${box}:`, err);
      res.status(500).json({ error: 'InternalServerError', message: `Failed to serve ${box}` });
    }
  });
}

/**
 * POST /ap/actor/:did/inbox (#464)
 *
 * A signed Follow of the community is answered with a signed Accept, sent
 * after the 202 so the sender is not kept waiting; everything else is
 * acknowledged and dropped (the PDS keeps no followers and the actor never
 * posts). See src/activitypub/follows.ts for the checks.
 */
const inboxLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.rateLimits.discoveryPerMin,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
const inboxBody = express.raw({
  type: ['application/activity+json', 'application/ld+json', 'application/json'],
  limit: '64kb',
});

router.post('/ap/actor/:did/inbox', inboxLimiter, inboxBody, async (req: Request, res: Response) => {
  try {
    const did = req.params.did as string;
    const lookup = await lookupActorCommunity(did);
    if (!lookup.found) {
      res.status(lookup.status).json({ error: lookup.error, message: lookup.message });
      return;
    }
    if (!Buffer.isBuffer(req.body)) {
      res.status(415).json({ error: 'UnsupportedMediaType', message: 'Send application/activity+json' });
      return;
    }
    const actorId = `${config.pds.serviceUrl}/ap/actor/${did}`;
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
    }
    const outcome = await handleInboxDelivery({ actorId, path: req.originalUrl, headers, body: req.body });
    if (outcome.status !== 202) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }
    res.status(202).end();
    if (!outcome.accept) return;
    const { follower, activity } = outcome.accept;
    const { privateKey } = await getOrCreateApKeys(did);
    deliverAccept({ actorId, privateKeyPem: privateKey, follower, follow: activity })
      .then((status) => {
        if (status >= 300) console.warn(`AP Accept to ${new URL(follower.inbox).host} answered ${status}`);
      })
      .catch((err) => console.warn('AP Accept delivery failed:', err instanceof Error ? err.message : err));
  } catch (err) {
    console.error('Error handling AP inbox delivery:', err);
    if (!res.headersSent) res.status(500).json({ error: 'InternalServerError' });
  }
});

/**
 * GET /.well-known/nodeinfo
 * NodeInfo discovery document.
 */
// Public, credential-free discovery documents: readable cross-origin, so a
// browser-based client can read them as it would WebFinger's (RFC 7033 §5).
router.get('/.well-known/nodeinfo', (_req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    links: [
      {
        rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
        href: `${config.pds.serviceUrl}/nodeinfo/2.1`,
      },
    ],
  });
});

/**
 * GET /nodeinfo/2.1
 * NodeInfo 2.1 document.
 */
router.get('/nodeinfo/2.1', async (_req: Request, res: Response) => {
  try {
    const userCount = await query<{ count: string }>(
      "SELECT COUNT(*) as count FROM users WHERE status = 'approved'",
    );

    // The 2.1 schema's `protocols` is a closed list that has no entry for
    // AT Protocol, and validating crawlers reject a document naming one, so
    // AT Protocol is declared in `metadata`, which the schema leaves open.
    res.setHeader('Content-Type', 'application/json; profile="http://nodeinfo.diaspora.software/ns/schema/2.1#"');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(JSON.stringify({
      version: '2.1',
      software: {
        name: 'openfederation-pds',
        version: SERVER_VERSION,
      },
      protocols: ['activitypub'],
      services: { inbound: [], outbound: [] },
      openRegistrations: false,
      usage: {
        users: { total: parseInt(userCount.rows[0]?.count || '0', 10) },
        localPosts: 0,
      },
      metadata: {
        nodeName: 'OpenFederation PDS',
        protocols: ['atprotocol', 'activitypub'],
      },
    }));
  } catch (err) {
    console.error('Error serving nodeinfo:', err);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to serve NodeInfo' });
  }
});

export { router as apRouter };
