import { Router, type Request, type Response } from 'express';
import { Secp256k1Keypair } from '@atproto/crypto';
import { query } from '../db/client.js';
import { config } from '../config.js';
import { discoveryLimiter } from './rate-limits.js';
import { communityFederationView } from '../federation/privacy.js';
import { toMultibaseMultikeySecp256k1 } from '../identity/manager.js';
import { decryptKeyBytes } from '../auth/encryption.js';

export function createWellKnownRouter(): Router {
  const router = Router();

  // /.well-known/did.json — serves DID documents for
  //   1. the PDS's own service DID (did:web:${config.pds.hostname}), OR
  //   2. a community registered at did:web:${config.pds.hostname} (unusual,
  //      legacy path — communities normally get did:plc now)
  // A PDS instance hosts exactly one hostname so the short-circuit at (1) fires
  // whenever the PDS's own service DID is requested. Communities under the
  // same hostname (if any) fall through to the existing lookup.
  router.get('/did.json', discoveryLimiter, async (req: Request, res: Response) => {
    try {
      // Use configured PDS hostname to prevent HTTP host header injection.
      // The Host header can be spoofed; trust only our configuration.
      const hostname = config.pds.hostname;
      if (!hostname) {
        return res.status(500).json({ error: 'InternalServerError', message: 'PDS hostname not configured' });
      }

      const did = `did:web:${hostname}`;

      // First: is a community registered at this exact DID? If so, honor the
      // existing community lookup (preserves back-compat for any did:web
      // communities from before this change).
      const communityResult = await query<{ did: string }>(
        'SELECT did FROM communities WHERE did = $1',
        [did]
      );

      if (communityResult.rows.length === 0) {
        // No community → serve the PDS's own service DID document.
        const { ensurePdsServiceKey } = await import('../identity/pds-service-key.js');
        const serviceKey = await ensurePdsServiceKey(hostname);
        const serviceDoc = {
          '@context': [
            'https://www.w3.org/ns/did/v1',
            'https://w3id.org/security/multikey/v1',
          ],
          id: did,
          alsoKnownAs: [`https://${hostname}`],
          verificationMethod: [
            {
              id: `${did}#atproto`,
              type: 'Multikey',
              controller: did,
              publicKeyMultibase: serviceKey.publicKeyMultibase,
            },
          ],
          assertionMethod: [`${did}#atproto`],
          service: [
            {
              id: '#atproto_pds',
              type: 'AtprotoPersonalDataServer',
              serviceEndpoint: config.pds.serviceUrl,
            },
          ],
        };
        res.setHeader('Content-Type', 'application/did+json');
        return res.json(serviceDoc);
      }

      // Community path (legacy) — load its signing key + augmentation.
      const keyResult = await query<{ signing_key_bytes: Buffer }>(
        'SELECT signing_key_bytes FROM signing_keys WHERE community_did = $1',
        [did]
      );

      if (keyResult.rows.length === 0) {
        return res.status(500).json({ error: 'InternalServerError', message: 'Signing key not found' });
      }

      const decrypted = await decryptKeyBytes(keyResult.rows[0].signing_key_bytes, 'identity.signing-key');
      const keypair = await Secp256k1Keypair.import(decrypted, { exportable: false });
      const publicKeyMultibase = toMultibaseMultikeySecp256k1(keypair.publicKeyBytes());

      // Augment the DID doc with any linked wallets (blockchainAccountId via
      // CAIP-10). Standards-compliant W3C DID resolvers will surface the
      // user's Ethereum + Solana addresses as verification methods.
      const { buildDidAugmentation } = await import('../identity/did-augment.js');
      const { resolveChainIdCaip2 } = await import('../identity/siwof.js');
      const walletsRes = await query<{ chain: 'ethereum' | 'solana'; wallet_address: string; is_primary: boolean }>(
        `SELECT chain, wallet_address, is_primary FROM wallet_links
         WHERE user_did = $1 AND custody_status = 'active'
         ORDER BY is_primary DESC, chain, linked_at`,
        [did]
      );
      const aug = buildDidAugmentation(
        did,
        walletsRes.rows.map((r) => ({
          chain: r.chain,
          walletAddress: r.wallet_address,
          chainIdCaip2: resolveChainIdCaip2(r.chain),
          isPrimary: r.is_primary,
        })),
      );

      const context: string[] = ['https://www.w3.org/ns/did/v1'];
      if (aug.verificationMethod.length > 0) {
        context.push('https://w3id.org/security/suites/secp256k1-2019/v1');
        context.push('https://w3id.org/security/suites/ed25519-2020/v1');
      }

      const didDocument = {
        '@context': context,
        id: did,
        alsoKnownAs: [`at://${hostname}`],
        verificationMethod: [
          {
            id: `${did}#atproto`,
            type: 'Multikey',
            controller: did,
            publicKeyMultibase,
          },
          ...aug.verificationMethod,
        ],
        ...(aug.assertionMethod.length > 0 ? { assertionMethod: aug.assertionMethod } : {}),
        ...(aug.authentication.length > 0 ? { authentication: aug.authentication } : {}),
        service: [
          {
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: config.pds.serviceUrl,
          },
        ],
      };

      res.setHeader('Content-Type', 'application/did+json');
      res.json(didDocument);
    } catch (err) {
      console.error('Error serving did.json:', err);
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to serve DID document' });
    }
  });

  // /.well-known/webfinger — AT Protocol discovery for users and communities
  router.get('/webfinger', discoveryLimiter, async (req: Request, res: Response) => {
    try {
      const resource = req.query.resource as string;
      if (!resource) {
        return res.status(400).json({ error: 'BadRequest', message: 'resource query parameter required' });
      }

      let subject: string;
      let did: string | null = null;

      if (resource.startsWith('acct:')) {
        // acct:handle@domain format
        const acct = resource.substring(5); // strip "acct:"
        const atIndex = acct.indexOf('@');
        if (atIndex === -1) {
          return res.status(400).json({ error: 'BadRequest', message: 'Invalid acct URI format' });
        }
        const handle = acct.substring(0, atIndex);
        subject = resource;

        // Try users first
        const userResult = await query<{ did: string }>(
          'SELECT did FROM users WHERE handle = $1',
          [handle]
        );
        if (userResult.rows.length > 0) {
          did = userResult.rows[0].did;
        } else {
          // Try communities
          const communityResult = await query<{ did: string }>(
            'SELECT did FROM communities WHERE handle = $1',
            [handle]
          );
          if (communityResult.rows.length > 0) {
            did = communityResult.rows[0].did;
          }
        }
      } else if (resource.startsWith('at://') || resource.startsWith('did:')) {
        // Direct DID or AT URI
        const lookupDid = resource.startsWith('at://') ? resource.substring(5) : resource;
        subject = resource;

        // Try users
        const userResult = await query<{ did: string }>(
          'SELECT did FROM users WHERE did = $1',
          [lookupDid]
        );
        if (userResult.rows.length > 0) {
          did = userResult.rows[0].did;
        } else {
          // Try communities
          const communityResult = await query<{ did: string }>(
            'SELECT did FROM communities WHERE did = $1',
            [lookupDid]
          );
          if (communityResult.rows.length > 0) {
            did = communityResult.rows[0].did;
          }
        }
      } else {
        return res.status(400).json({ error: 'BadRequest', message: 'Unsupported resource URI scheme' });
      }

      if (!did) {
        return res.status(404).json({ error: 'NotFound', message: 'Resource not found' });
      }

      // Check if this DID is a community with linked AP applications
      let apActorUrl = config.pds.serviceUrl; // default: generic PDS URL
      const links: Array<{ rel: string; type: string; href: string }> = [];

      if (config.activitypub.enabled) {
        const apAppResult = await query<{ count: string }>(
          `SELECT COUNT(*) as count FROM records_index
           WHERE community_did = $1 AND collection = 'net.openfederation.community.application'`,
          [did]
        );
        if (parseInt(apAppResult.rows[0]?.count || '0', 10) > 0) {
          // Community has linked AP apps — point to the real AP actor. A
          // private community still resolves (existence is public via PLC,
          // and its deliberately linked AP instances need the actor for
          // addressing) but content-bearing links are withheld: the actor it
          // points to is served stripped, and the profile page is not
          // advertised (#85, ADR-001).
          apActorUrl = `${config.pds.serviceUrl}/ap/actor/${did}`;
          if (await communityFederationView(did) === 'public') {
            links.push({
              rel: 'http://webfinger.net/rel/profile-page',
              type: 'text/html',
              href: `${config.pds.serviceUrl}/communities/${did}`,
            });
          }
        }
      }

      links.unshift(
        {
          rel: 'self',
          type: 'application/activity+json',
          href: apActorUrl,
        },
        {
          rel: 'self',
          type: 'application/json',
          href: did,
        },
      );

      const webfingerResponse = { subject, links };

      res.setHeader('Content-Type', 'application/jrd+json');
      res.json(webfingerResponse);
    } catch (err) {
      console.error('Error serving webfinger:', err);
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to serve WebFinger response' });
    }
  });

  return router;
}
