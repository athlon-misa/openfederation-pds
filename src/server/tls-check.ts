/**
 * GET /tls-check?domain=<name> (#405).
 *
 * The question a reverse proxy with on-demand TLS asks before it requests a
 * certificate: Caddy's `on_demand_tls { ask http://pds:8080/tls-check }` in
 * deploy/appliance/Caddyfile. With a wildcard DNS record for the handle
 * domain (*.example.org pointing here), every name under it reaches the
 * proxy, and a certificate is needed per name for
 * https://<handle>/.well-known/atproto-did. Answering 200 only for this
 * server's own handles stops anyone from making the proxy request
 * certificates for made-up names (and running into the CA's rate limits).
 *
 * It says no more than /.well-known/atproto-did and resolveHandle already
 * do publicly: whether a handle exists here.
 */
import { Router, type Request, type Response } from 'express';
import { query } from '../db/client.js';
import { config } from '../config.js';
import { discoveryLimiter } from './rate-limits.js';

/** The short handle a host name stands for under this server's handle domain, or null. */
export function handleForHost(host: string, handleSuffix: string = config.handleSuffix): string | null {
  const name = host.trim().toLowerCase().replace(/\.$/, '');
  const suffix = handleSuffix.toLowerCase();
  if (!suffix || name.length > 253 || !name.endsWith(suffix)) return null;
  const bare = name.slice(0, -suffix.length);
  if (!bare || bare.includes('.')) return null;
  return bare;
}

/** The DID of this server's user or community with that handle, or null. */
export async function localDidForHandle(bare: string): Promise<string | null> {
  const [user, community] = await Promise.all([
    query<{ did: string }>('SELECT did FROM users WHERE handle = $1', [bare]),
    query<{ did: string }>('SELECT did FROM communities WHERE handle = $1', [bare]),
  ]);
  return user.rows[0]?.did ?? community.rows[0]?.did ?? null;
}

export function createTlsCheckRouter(): Router {
  const router = Router();
  router.get('/tls-check', discoveryLimiter, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const domain = typeof req.query.domain === 'string' ? req.query.domain : '';
    const bare = handleForHost(domain);
    try {
      if (bare && (await localDidForHandle(bare))) {
        res.status(200).type('text/plain').send('ok');
        return;
      }
    } catch (err) {
      console.error('Error answering tls-check:', err);
      res.status(500).type('text/plain').send('Error');
      return;
    }
    res.status(404).type('text/plain').send('Not found');
  });
  return router;
}
