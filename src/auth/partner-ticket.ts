/**
 * Registration tickets for partner keys.
 *
 * A partner key is sent from browsers, so presenting one proves nothing about
 * who is calling: anyone can copy it out of the partner's page and replay it
 * with a forged `Origin`. A partner that has a backend registers a public key
 * with its partner key (`ticketPublicKey`). Its backend then signs a ticket
 * for each sign-up, and `partner.register` accepts the sign-up only with a
 * ticket that:
 *
 *  - is signed by that key,
 *  - is addressed to this PDS and issued for this partner key,
 *  - names the handle and email being registered,
 *  - is still within its (short) lifetime, and
 *  - has not been used before.
 *
 * The matching signer is `createPartnerTicket` in `@open-federation/sdk`.
 */
import type { PoolClient } from 'pg';
import { parseDidKey, verifySignature } from '@atproto/crypto';
import { config } from '../config.js';

/** Longest lifetime a ticket may have. They are minted per sign-up and used at once. */
const MAX_TICKET_LIFETIME_SEC = 300;
const CLOCK_SKEW_SEC = 30;
const JWT_ALGS = new Set(['ES256K', 'ES256']);

export class PartnerTicketError extends Error {
  constructor(public readonly code: 'TicketRequired' | 'TicketInvalid', message: string) {
    super(message);
    this.name = 'PartnerTicketError';
  }
}

/** A message about a `ticketPublicKey` that cannot be used, or null if it is fine. */
export function invalidTicketPublicKey(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('did:key:')) {
    return 'ticketPublicKey must be a did:key (secp256k1 or P-256)';
  }
  try {
    const parsed = parseDidKey(value);
    if (!JWT_ALGS.has(parsed.jwtAlg)) return 'ticketPublicKey must be a secp256k1 or P-256 key';
    return null;
  } catch {
    return 'ticketPublicKey is not a valid did:key';
  }
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf-8')) as Record<string, unknown>;
}

/**
 * Check a ticket and mark it used, inside the caller's transaction (so a
 * registration that fails afterwards does not burn the ticket, and two
 * requests with the same ticket cannot both pass). Throws PartnerTicketError.
 */
export async function redeemPartnerTicket(client: PoolClient, input: {
  ticket: unknown;
  ticketPublicKey: string;
  partnerKeyId: string;
  handle: string;
  email: string;
}): Promise<void> {
  if (typeof input.ticket !== 'string' || input.ticket.length === 0) {
    throw new PartnerTicketError('TicketRequired', 'This partner key requires a registration ticket signed by the partner');
  }
  const bad = (why: string) => new PartnerTicketError('TicketInvalid', `Registration ticket refused: ${why}`);

  const parts = input.ticket.split('.');
  if (parts.length !== 3) throw bad('not a signed token');
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeSegment(parts[0]);
    claims = decodeSegment(parts[1]);
  } catch {
    throw bad('not a signed token');
  }

  const keyAlg = parseDidKey(input.ticketPublicKey).jwtAlg;
  if (header.alg !== keyAlg) throw bad('signed with the wrong kind of key');

  const now = Math.floor(Date.now() / 1000);
  const { iss, aud, exp, jti } = claims;
  if (iss !== input.partnerKeyId) throw bad('issued for a different partner key');
  if (aud !== config.pds.serviceDid) throw bad('addressed to a different server');
  if (typeof exp !== 'number' || !Number.isFinite(exp)) throw bad('no expiry');
  if (exp + CLOCK_SKEW_SEC < now) throw bad('expired');
  if (exp > now + MAX_TICKET_LIFETIME_SEC + CLOCK_SKEW_SEC) throw bad(`valid for longer than ${MAX_TICKET_LIFETIME_SEC} seconds`);
  if (typeof jti !== 'string' || jti.length < 16 || jti.length > 128) throw bad('no usable ticket id');
  // The ticket is for one account. Without this binding a ticket lifted from
  // one sign-up could be spent registering something else.
  if (claims.handle !== input.handle || claims.email !== input.email) throw bad('issued for a different account');

  let verified = false;
  try {
    verified = await verifySignature(
      input.ticketPublicKey,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      Buffer.from(parts[2], 'base64url'),
      { jwtAlg: keyAlg },
    );
  } catch {
    verified = false;
  }
  if (!verified) throw bad('signature does not verify');

  // Single use. Keyed on the partner key and the ticket id; kept until the
  // ticket would have expired anyway.
  const used = await client.query(
    `INSERT INTO partner_ticket_uses (partner_key_id, jti, expires_at)
     VALUES ($1, $2, to_timestamp($3))
     ON CONFLICT (partner_key_id, jti) DO NOTHING`,
    [input.partnerKeyId, jti, exp + CLOCK_SKEW_SEC],
  );
  if (used.rowCount !== 1) throw bad('already used');
  await client.query('DELETE FROM partner_ticket_uses WHERE expires_at < CURRENT_TIMESTAMP');
}
