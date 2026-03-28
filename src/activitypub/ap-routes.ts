/**
 * ActivityPub Routes
 *
 * Express router for AP-compatible discovery endpoints:
 * - GET /ap/actor/:did — AP Group actor document for communities with linked apps
 * - GET /.well-known/nodeinfo — NodeInfo discovery
 * - GET /nodeinfo/2.1 — NodeInfo 2.1 document
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { config } from '../config.js';
import { query } from '../db/client.js';
import { encryptKeyBytes, decryptKeyBytes } from '../auth/encryption.js';
import { buildCommunityActor, type ApplicationRecord } from './ap-actors.js';

const router = Router();

// In-memory cache for RSA key pairs per community DID (performance — avoids repeated DB lookups)
const rsaKeyCache = new Map<string, { publicKey: string; privateKey: string }>();

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
    const privateKey = (await decryptKeyBytes(row.encrypted_private_key)).toString('utf-8');
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
  const encryptedPrivateKey = await encryptKeyBytes(Buffer.from(privateKey, 'utf-8'));

  await query(
    'INSERT INTO ap_signing_keys (did, public_key_pem, encrypted_private_key) VALUES ($1, $2, $3) ON CONFLICT (did) DO NOTHING',
    [did, publicKey, encryptedPrivateKey],
  );

  const keys = { publicKey: publicKey as string, privateKey: privateKey as string };
  rsaKeyCache.set(did, keys);
  return keys;
}

/**
 * GET /ap/actor/:did
 * Returns an ActivityPub Group actor document for a community.
 * Only returns an actor if the community has linked AP applications.
 */
router.get('/ap/actor/:did', async (req: Request, res: Response) => {
  try {
    const did = req.params.did as string;
    if (!did || !did.startsWith('did:')) {
      res.status(400).json({ error: 'BadRequest', message: 'Invalid DID format' });
      return;
    }

    // Look up community
    const communityResult = await query<{
      did: string;
      handle: string;
      created_at: string;
      status: string;
    }>(
      'SELECT did, handle, created_at, status FROM communities WHERE did = $1',
      [did],
    );

    if (communityResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    const communityRow = communityResult.rows[0];

    if (communityRow.status !== 'active') {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    // Load profile from repo records (display name, description are stored as records, not DB columns)
    const profileResult = await query<{
      record: { displayName?: string; description?: string };
    }>(
      `SELECT record FROM records_index
       WHERE community_did = $1 AND collection = 'net.openfederation.community.profile' LIMIT 1`,
      [did],
    );
    const profile = profileResult.rows[0]?.record || {};

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
      res.status(404).json({ error: 'NotFound', message: 'No linked applications for this community' });
      return;
    }

    const applications: ApplicationRecord[] = appResult.rows.map((row) => ({
      appType: row.record.appType,
      instanceUrl: row.record.instanceUrl,
      displayName: row.record.displayName,
    }));

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
    );

    res.setHeader('Content-Type', 'application/activity+json');
    res.json(actor);
  } catch (err) {
    console.error('Error serving AP actor:', err);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to serve actor document' });
  }
});

/**
 * GET /.well-known/nodeinfo
 * NodeInfo discovery document.
 */
router.get('/.well-known/nodeinfo', (_req: Request, res: Response) => {
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

    res.json({
      version: '2.1',
      software: {
        name: 'openfederation-pds',
        version: '1.0.0',
      },
      protocols: ['atprotocol', 'activitypub'],
      services: { inbound: [], outbound: [] },
      openRegistrations: false,
      usage: {
        users: { total: parseInt(userCount.rows[0]?.count || '0', 10) },
        localPosts: 0,
      },
      metadata: {
        nodeName: 'OpenFederation PDS',
      },
    });
  } catch (err) {
    console.error('Error serving nodeinfo:', err);
    res.status(500).json({ error: 'InternalServerError', message: 'Failed to serve NodeInfo' });
  }
});

export { router as apRouter };
