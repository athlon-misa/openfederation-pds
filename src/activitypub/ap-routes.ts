/**
 * ActivityPub Routes
 *
 * Express router for AP-compatible discovery endpoints:
 * - GET /ap/actor/:did — AP Group actor document for communities with linked apps
 * - GET /.well-known/nodeinfo — NodeInfo discovery
 * - GET /nodeinfo/2.1 — NodeInfo 2.1 document
 */

import { Router, Request, Response } from 'express';
import { config } from '../config.js';
import { query } from '../db/client.js';
import { buildCommunityActor, type ApplicationRecord } from './ap-actors.js';
import { Secp256k1Keypair } from '@atproto/crypto';
import { decryptKeyBytes } from '../auth/encryption.js';

const router = Router();

/**
 * Convert a secp256k1 compressed public key to SPKI PEM format.
 * This is needed for the AP actor's publicKey field.
 */
function secp256k1PublicKeyToPem(compressedPubKey: Uint8Array): string {
  // SPKI DER structure for secp256k1:
  // SEQUENCE {
  //   SEQUENCE {
  //     OID 1.2.840.10045.2.1 (ecPublicKey)
  //     OID 1.3.132.0.10 (secp256k1)
  //   }
  //   BIT STRING (uncompressed or compressed public key)
  // }
  // For compressed 33-byte key:
  const algorithmIdentifier = Buffer.from([
    0x30, 0x10, // SEQUENCE, 16 bytes
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // OID ecPublicKey
    0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a, // OID secp256k1
  ]);

  const bitString = Buffer.alloc(2 + compressedPubKey.length);
  bitString[0] = 0x03; // BIT STRING tag
  bitString[1] = compressedPubKey.length + 1; // length (key bytes + 1 for unused bits byte)
  // Actually need to include the "unused bits" byte
  const bitStringFull = Buffer.alloc(3 + compressedPubKey.length);
  bitStringFull[0] = 0x03; // BIT STRING tag
  bitStringFull[1] = compressedPubKey.length + 1; // content length
  bitStringFull[2] = 0x00; // 0 unused bits
  Buffer.from(compressedPubKey).copy(bitStringFull, 3);

  const spkiContent = Buffer.concat([algorithmIdentifier, bitStringFull]);
  const spki = Buffer.alloc(2 + spkiContent.length);
  spki[0] = 0x30; // SEQUENCE tag
  spki[1] = spkiContent.length;
  spkiContent.copy(spki, 2);

  const base64 = spki.toString('base64');
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
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
      display_name: string | null;
      description: string | null;
      created_at: string;
      status: string;
    }>(
      'SELECT did, handle, display_name, description, created_at, status FROM communities WHERE did = $1',
      [did],
    );

    if (communityResult.rows.length === 0) {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

    const community = communityResult.rows[0];

    if (community.status !== 'active') {
      res.status(404).json({ error: 'NotFound', message: 'Community not found' });
      return;
    }

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

    // Load signing key for public key
    const keyResult = await query<{ signing_key_bytes: Buffer }>(
      'SELECT signing_key_bytes FROM signing_keys WHERE community_did = $1',
      [did],
    );

    let publicKeyPem = '';
    if (keyResult.rows.length > 0) {
      const decrypted = decryptKeyBytes(keyResult.rows[0].signing_key_bytes);
      const keypair = await Secp256k1Keypair.import(decrypted, { exportable: false });
      publicKeyPem = secp256k1PublicKeyToPem(keypair.publicKeyBytes());
    }

    const actor = buildCommunityActor(
      {
        did: community.did,
        handle: community.handle,
        display_name: community.display_name || undefined,
        description: community.description || undefined,
        created_at: community.created_at,
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
