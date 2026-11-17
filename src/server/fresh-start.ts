/**
 * What a fresh start of this process consists of, so the demo reset
 * (src/demo/demo-mode.ts) can bring a running server back to it after
 * emptying the database, without exiting and relying on the platform to start
 * it again (on 2026-11-16 Railway marked a demo PDS crashed after the exit
 * and never restarted it).
 *
 * Two halves:
 *   - seedStartupData(): the rows a normal start creates. startServer() calls
 *     it too, so the two cannot drift: add any new start-up seeding here.
 *   - clearInMemoryState(): every cache in this process that holds data read
 *     from the database or from other servers, per account or per DID. A new
 *     process starts with all of them empty. Add any new such cache here.
 *
 * Deliberately not cleared:
 *   - the IP rate limiters (src/server/rate-limits.ts) and the service-auth
 *     replay cache: abuse and replay protection, holding nothing from the
 *     deleted rows; emptying them would only let a client start over (the
 *     replay entries expire with their tokens within minutes);
 *   - configuration read at start (config, chain adapters, the OAuth provider
 *     and its routes, the lexicon schemas, the SDK bundle), the repo write
 *     queues (they empty themselves once the drained requests are done), and
 *     the OAuth provider's client-lexicon store (client documents, no
 *     accounts).
 */
import { ensureBootstrapAdmin } from '../auth/bootstrap.js';
import { completePendingSetupAdmin } from '../auth/setup-admin.js';
import { startRuntimeSettings, resetRuntimeSettingsToStartup } from '../settings/runtime-settings.js';
import { clearKeypairCache } from '../auth/keypair-cache.js';
import { _clearAuthContextCache } from '../auth/auth-context-cache.js';
import { _resetServiceAuthRateLimiter } from '../auth/service-auth.js';
import { clearProbationCounters } from '../auth/pseudonym-probation.js';
import { clearPartnerOriginsCache } from '../auth/partner-guard.js';
import { clearDidResolverCache } from '../identity/did-resolver.js';
import { _clearExternalHandleCache } from '../identity/external-handle-resolver.js';
import { clearTokenKeyCache } from '../identity/pseudonym/tokens.js';
import { _clearBlockCache } from '../repo/block-cache.js';
import { _clearActivityFeedCache } from '../activity/feed.js';
import { _clearRemoteActivityCache } from '../activity/timeline.js';
import { clearPeerDidCache } from '../activity/remote.js';
import { _clearDiscoveryCache } from '../federation/community-discovery.js';
import { clearPeerCaches } from '../federation/peer-cache.js';
import { _clearRemoteVerificationCache } from '../federation/remote-verify.js';
import { clearApKeyCache } from '../activitypub/ap-routes.js';
import { clearPendingCodes } from '../oauth/external-routes.js';

/**
 * The rows a start creates: the admin's dashboard settings read (#410), the
 * bootstrap admin from the environment when configured, and the setup
 * wizard's admin when one is waiting. Throws when one of them fails.
 *
 * Everything else a start needs is created on first use: the pseudonym pass
 * key of the month (src/identity/pseudonym/tokens.ts), the service DID's key
 * (src/identity/pds-service-key.ts), ActivityPub keys.
 */
export async function seedStartupData(): Promise<void> {
  await startRuntimeSettings();
  await ensureBootstrapAdmin();
  const setupAdmin = await completePendingSetupAdmin();
  if (setupAdmin !== 'none') console.log('✓ Admin account from the setup wizard created');
}

/** Empty every in-process cache of data from the database or other servers. */
export async function clearInMemoryState(): Promise<void> {
  // Decrypted secrets first.
  clearKeypairCache();                // repo signing keys, by DID
  clearTokenKeyCache();               // pseudonym pass keys: a stale one would keep old passes redeemable
  clearApKeyCache();                  // ActivityPub RSA keys, by community DID
  clearPendingCodes();                // "Sign in with ATProto" handoff codes, by account

  // Who someone is and what they may do.
  _clearAuthContextCache();           // OAuth / service-auth DID -> user, roles, status
  await clearDidResolverCache();      // DID documents (the demo PLC directory is wiped too)
  _clearExternalHandleCache();        // handle -> DID
  clearPartnerOriginsCache();         // CORS origins of partner keys
  _resetServiceAuthRateLimiter();     // per-DID counters for DIDs that no longer exist
  clearProbationCounters();           // pseudonym daily write counts, by account
  resetRuntimeSettingsToStartup();    // the admin's changes from server_settings

  // Content.
  _clearBlockCache();                 // repo blocks, by DID
  _clearActivityFeedCache();          // community activity feeds
  _clearRemoteActivityCache();        // memberships, remote feeds, community PDS URLs
  clearPeerDidCache();                // peers' service DIDs
  _clearDiscoveryCache();             // peers' community directories
  clearPeerCaches();                  // peers' communities and info
  _clearRemoteVerificationCache();    // records verified on other servers
}
