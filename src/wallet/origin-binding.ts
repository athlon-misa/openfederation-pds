import { normalizeDappOrigin } from './consent.js';

/**
 * Bind a wallet consent operation to the browser-supplied `Origin` header.
 *
 * A `wallet_dapp_consents` row authorizes one dApp origin to have the PDS sign
 * with a custodial key. Before this guard, that origin arrived only as a
 * caller-declared value — a JSON body field or the `X-dApp-Origin` header —
 * which anyone holding a user bearer token could set to anything. Two things
 * followed, and the guard has to close both:
 *
 *   replay  declare another dApp's origin and sign under a consent that dApp
 *           received (the reported issue, #101)
 *   mint    call grantConsent with an arbitrary origin and then sign under it,
 *           which needs no pre-existing consent at all
 *
 * `Origin` is set by the browser and cannot be forged by page script on a
 * cross-origin request, so it is the one origin signal the server can trust
 * from an untrusted client. Requiring it makes the consent row mean what it
 * always claimed to.
 *
 * Deliberately fails closed when the header is absent. A non-browser client can
 * set any header it likes, so treating "no Origin" as permissible would leave
 * the whole guard opt-out — the caller would simply omit it. That does mean
 * server-to-server callers cannot perform custodial signing; they are expected
 * to hold their own keys (Tier 2/3) rather than ask the PDS to sign for them.
 */
export type DappOriginBindingCode = 'OriginRequired' | 'OriginMismatch';

export class DappOriginBindingRejection extends Error {
  constructor(
    public readonly code: DappOriginBindingCode,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DappOriginBindingRejection';
  }
}

/**
 * Require `requestOrigin` (the `Origin` header as the server read it) to be
 * present and to name the same origin as `declaredOrigin`.
 *
 * Returns the canonical origin, so callers use the verified value rather than
 * the one they were handed.
 */
export function assertDappOriginBinding(
  requestOrigin: string | undefined,
  declaredOrigin: string,
): string {
  if (!requestOrigin || typeof requestOrigin !== 'string' || requestOrigin === 'null') {
    // "null" is what a browser sends from a sandboxed or opaque origin; it
    // identifies nothing and must not satisfy the binding.
    throw new DappOriginBindingRejection(
      'OriginRequired',
      403,
      'Custodial wallet consent requires a browser Origin header. Server-side clients must use a Tier 2 or Tier 3 wallet and sign locally.',
    );
  }

  let canonicalRequest: string;
  try {
    canonicalRequest = normalizeDappOrigin(requestOrigin);
  } catch {
    throw new DappOriginBindingRejection('OriginRequired', 403, 'Origin header is not a valid origin');
  }

  let canonicalDeclared: string;
  try {
    canonicalDeclared = normalizeDappOrigin(declaredOrigin);
  } catch (err) {
    // Surfaced as a mismatch rather than a 400: the declared value cannot be
    // reconciled with the origin the request actually came from.
    throw new DappOriginBindingRejection('OriginMismatch', 403, (err as Error).message);
  }

  if (canonicalRequest !== canonicalDeclared) {
    throw new DappOriginBindingRejection(
      'OriginMismatch',
      403,
      'dappOrigin does not match the Origin this request was sent from',
    );
  }

  return canonicalDeclared;
}
