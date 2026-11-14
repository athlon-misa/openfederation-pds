import { Router, type Request, type Response } from 'express';
import { Secp256k1Keypair } from '@atproto/crypto';
import { query } from '../db/client.js';
import { localHandle } from '../auth/utils.js';
import { config } from '../config.js';
import { discoveryLimiter } from './rate-limits.js';
import { communityFederationView } from '../federation/privacy.js';
import { communityProfileUrl } from '../activitypub/ap-actors.js';
import { buildLocalDirectory } from '../federation/community-discovery.js';
import { toMultibaseMultikeySecp256k1 } from '../identity/manager.js';
import { decryptKeyBytes } from '../auth/encryption.js';
import { buildSecurityTxt, securityContactsFromEnv } from './security-txt.js';
import { handleForHost, localDidForHandle } from './tls-check.js';

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

  // AT Protocol handle verification over HTTPS: https://<handle>/.well-known/atproto-did
  // answers the handle's DID as plain text. With a wildcard DNS record
  // (*.<handle domain> pointing here, which the setup wizard shows, #405),
  // every name under this server's handle domain reaches this route, and other
  // AT Protocol services can confirm the name belongs to the account. Answers
  // the same lookup as com.atproto.identity.resolveHandle, for this server's
  // own names only.
  router.get('/atproto-did', discoveryLimiter, async (req: Request, res: Response) => {
    try {
      const bare = handleForHost(req.hostname || '');
      const did = bare ? await localDidForHandle(bare) : null;
      if (!did) {
        res.status(404).type('text/plain').send('Not found');
        return;
      }
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.status(200).type('text/plain').send(did);
    } catch (err) {
      console.error('Error serving atproto-did:', err);
      res.status(500).type('text/plain').send('Error');
    }
  });

  // /.well-known/webfinger — AT Protocol discovery for users and communities
  // RFC 9116: where to report a vulnerability in this instance.
  router.get('/security.txt', discoveryLimiter, (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('text/plain').send(buildSecurityTxt({
      contacts: securityContactsFromEnv(process.env.SECURITY_CONTACT),
      serviceUrl: config.pds.serviceUrl,
    }));
  });

  // Cross-server community discovery (#41): this server's public communities,
  // fetched by peers for net.openfederation.community.discover. Same
  // public-only filter as community.listAll; never includes peers' lists.
  router.get('/openfederation-communities.json', discoveryLimiter, async (_req: Request, res: Response) => {
    try {
      const directory = await buildLocalDirectory();
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.status(200).json(directory);
    } catch (err) {
      console.error('Error serving community directory:', err);
      res.status(500).json({ error: 'InternalServerError', message: 'Failed to list communities' });
    }
  });

  router.get('/webfinger', discoveryLimiter, async (req: Request, res: Response) => {
    // RFC 7033 §5: WebFinger servers MUST send this on every response, so
    // browser-based clients can resolve accounts. Nothing here is credentialed.
    res.setHeader('Access-Control-Allow-Origin', '*');
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
        // The short name or the full handle (name + this server's domain).
        const handle = localHandle(acct.substring(0, atIndex));
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

      // Check if this DID is a community with linked AP applications. Only
      // then is there an ActivityPub actor to point at: advertising an
      // activity+json `self` link for anything else sends an AP client
      // (Mastodon resolves exactly this link) to a document that is not an
      // actor. The conditions match the ones /ap/actor/:did serves under.
      let apActorUrl: string | null = null;
      const links: Array<{ rel: string; type: string; href: string }> = [];

      if (config.activitypub.enabled) {
        const apAppResult = await query<{ count: string }>(
          `SELECT COUNT(*) as count FROM records_index r
           JOIN communities c ON c.did = r.community_did AND c.status = 'active'
           WHERE r.community_did = $1 AND r.collection = 'net.openfederation.community.application'`,
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
          const profileUrl = communityProfileUrl(config.federation.webUiUrl, did);
          if (profileUrl && await communityFederationView(did) === 'public') {
            links.push({
              rel: 'http://webfinger.net/rel/profile-page',
              type: 'text/html',
              href: profileUrl,
            });
          }
        }
      }

      links.unshift(
        ...(apActorUrl ? [{
          rel: 'self',
          type: 'application/activity+json',
          href: apActorUrl,
        }] : []),
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
