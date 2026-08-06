/**
 * Redemption rules for the external-login handoff code (#146).
 *
 * The reported attack: complete OAuth as the attacker, withhold the 60-second
 * code, send `/callback?code=...` to a victim. Their browser exchanges it and is
 * signed in as the attacker.
 *
 * Codes are minted inside the OAuth callback, which needs a live external PDS to
 * redirect through, so these seed a code directly and drive the real
 * `/oauth/external/complete` route over HTTP. That is where the security
 * decision lives.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { app } from '../../src/server/index.js';
import {
  seedPendingCodeForTests,
  deriveChallenge,
  createExternalOAuthRouter,
} from '../../src/oauth/external-routes.js';
import { query } from '../../src/db/client.js';

// The external OAuth routes are mounted by startServer(), which the test app
// does not run. Mount the real router so these exercise the actual handler.
beforeAll(() => {
  app.use(createExternalOAuthRouter());
});

const complete = (body: Record<string, unknown>) =>
  request(app).post('/oauth/external/complete').send(body);

/**
 * Distinguishes this run's rows from every earlier run's.
 *
 * `audit_log` is never truncated between runs, so an assertion keyed only on
 * the action would match rows left behind by previous runs against the same
 * database (#203).
 */
const RUN = Math.random().toString(36).slice(2, 8);
let n = 0;
function seed(opts: { challenge: string | null; requiresVerifier: boolean }) {
  const code = `test-code-${Date.now()}-${n++}`;
  seedPendingCodeForTests(code, {
    tokens: {
      did: `did:plc:handoff${RUN}${n}`,
      handle: `handoff${n}.test`,
      email: `handoff${n}@test.local`,
      accessJwt: 'access-jwt',
      refreshJwt: 'refresh-jwt',
    },
    expiresAt: Date.now() + 60_000,
    codeChallenge: opts.challenge,
    requiresVerifier: opts.requiresVerifier,
  });
  return code;
}

describe('external login handoff redemption (#146)', () => {
  describe('the reported attack', () => {
    it("refuses a code redeemed without the initiating browser's verifier", async () => {
      const verifier = crypto.randomBytes(32).toString('base64url');
      const code = seed({ challenge: deriveChallenge(verifier), requiresVerifier: true });

      // The victim's browser has the code but never had the verifier.
      const res = await complete({ code });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidCode');
      expect(res.body.accessJwt).toBeUndefined();
    });

    it('refuses a code redeemed with the wrong verifier', async () => {
      const code = seed({
        challenge: deriveChallenge(crypto.randomBytes(32).toString('base64url')),
        requiresVerifier: true,
      });
      const res = await complete({ code, codeVerifier: crypto.randomBytes(32).toString('base64url') });
      expect(res.status).toBe(400);
      expect(res.body.accessJwt).toBeUndefined();
    });

    it('lets the browser that started the flow redeem it', async () => {
      const verifier = crypto.randomBytes(32).toString('base64url');
      const code = seed({ challenge: deriveChallenge(verifier), requiresVerifier: true });

      const res = await complete({ code, codeVerifier: verifier });
      expect(res.status).toBe(200);
      expect(res.body.accessJwt).toBe('access-jwt');
      expect(res.body.active).toBe(true);
    });
  });

  describe('downgrade attempts', () => {
    it('refuses a web-flow code that carries no challenge at all', async () => {
      // An attacker who forces the SDK branch (the web UI origin is an allowed
      // redirect target) would otherwise get an unbound code the web callback
      // would happily redeem.
      const code = seed({ challenge: null, requiresVerifier: true });
      const res = await complete({ code });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidCode');
    });

    it('does not accept a verifier as a substitute for the challenge', async () => {
      const code = seed({ challenge: null, requiresVerifier: true });
      const res = await complete({ code, codeVerifier: 'anything' });
      expect(res.status).toBe(400);
    });
  });

  describe('single use', () => {
    it('burns the code even when verification fails', async () => {
      const verifier = crypto.randomBytes(32).toString('base64url');
      const code = seed({ challenge: deriveChallenge(verifier), requiresVerifier: true });

      const first = await complete({ code }); // wrong: no verifier
      expect(first.status).toBe(400);

      // The real owner cannot use it afterwards either — a failed attempt must
      // not leave the code sitting there for a retry.
      const second = await complete({ code, codeVerifier: verifier });
      expect(second.status).toBe(400);
    });

    it('burns the code on success', async () => {
      const verifier = crypto.randomBytes(32).toString('base64url');
      const code = seed({ challenge: deriveChallenge(verifier), requiresVerifier: true });

      expect((await complete({ code, codeVerifier: verifier })).status).toBe(200);
      expect((await complete({ code, codeVerifier: verifier })).status).toBe(400);
    });
  });

  describe('SDK redirect flow', () => {
    it('still redeems without a verifier, since consumers validate their own state', async () => {
      const code = seed({ challenge: null, requiresVerifier: false });
      const res = await complete({ code });
      expect(res.status).toBe(200);
      expect(res.body.accessJwt).toBe('access-jwt');
    });

    it('enforces the verifier anyway when the consumer supplied a challenge', async () => {
      const verifier = crypto.randomBytes(32).toString('base64url');
      const code = seed({ challenge: deriveChallenge(verifier), requiresVerifier: false });

      expect((await complete({ code })).status).toBe(400);

      const code2 = seed({ challenge: deriveChallenge(verifier), requiresVerifier: false });
      expect((await complete({ code: code2, codeVerifier: verifier })).status).toBe(200);
    });
  });

  describe('basics', () => {
    it('rejects a missing code', async () => {
      const res = await complete({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidRequest');
    });

    it('rejects an unknown code', async () => {
      const res = await complete({ code: 'never-issued', codeVerifier: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('InvalidCode');
    });

    it('rejects an expired code', async () => {
      const verifier = crypto.randomBytes(32).toString('base64url');
      const code = `expired-${Date.now()}`;
      seedPendingCodeForTests(code, {
        tokens: {
          did: 'did:plc:expired', handle: 'e.test', email: 'e@test.local',
          accessJwt: 'a', refreshJwt: 'r',
        },
        expiresAt: Date.now() - 1,
        codeChallenge: deriveChallenge(verifier),
        requiresVerifier: true,
      });
      const res = await complete({ code, codeVerifier: verifier });
      expect(res.status).toBe(400);
    });
  });

  describe('audit trail', () => {
    it('records a refused redemption', async () => {
      const verifier = crypto.randomBytes(32).toString('base64url');
      const code = seed({ challenge: deriveChallenge(verifier), requiresVerifier: true });
      await complete({ code }); // no verifier

      const rows = await query<{ meta: any }>(
        `SELECT meta FROM audit_log
          WHERE action = 'auth.external.handoffRejected'
            AND target_id LIKE $1
          ORDER BY created_at DESC LIMIT 1`,
        [`did:plc:handoff${RUN}%`],
      );
      expect(rows.rows.length).toBe(1);
      expect(rows.rows[0].meta.reason).toBe('VerifierMissing');
    });
  });
});
