# Testing Guide

A practical guide for running and writing tests for the OpenFederation PDS.

---

## 1. Prerequisites

- **Node.js 18+** and **npm**
- **PostgreSQL 15** — required for integration and E2E tests
- **PLC directory** — required for integration tests that create users (creates real `did:plc` identities) and all E2E tests. Run locally via `npm run plc:dev` (port 2582).
- **`.env` file** configured with valid `AUTH_JWT_SECRET`, `KEY_ENCRYPTION_SECRET`, and `DB_*` variables. Copy from `.env.example` as a starting point.

---

## 2. Quick Start

| Command | What it runs | Needs DB? | Needs PLC? |
|---------|-------------|:---------:|:----------:|
| `npm test` | Security validation tests | No | No |
| `npm run test:api` | Integration + unit tests (vitest) | Yes | Optional |
| `npm run test:e2e` | End-to-end journey tests | Yes | Yes |
| `npm run test:api:watch` | Integration tests in watch mode | Yes | Optional |

---

## 3. Test Suites

| Suite | Script | Files | Description | Infrastructure |
|-------|--------|-------|-------------|---------------|
| Security | `npm test` | `tests/security-*.test.ts` | Input validation, JWT, encryption, guards, headers | None |
| Unit | `npm run test:api` | `tests/unit/**/*.test.ts` | Pure function tests (Shamir, wallet verifiers, encryption, watermark, session keys) | None |
| Integration | `npm run test:api` | `tests/api/**/*.test.ts` | XRPC endpoint tests against a live server | PostgreSQL, PLC (optional) |
| E2E | `npm run test:e2e` | `tests/e2e/**/*.test.ts` | Full user journey tests | PostgreSQL + PLC |

### Security tests

Run entirely in-process with no external dependencies. They cover:

- `security-validation.test.ts` — handle, password, domain, and body size validation
- `security-jwt.test.ts` — JWT signing, verification, and expiry
- `security-encryption.test.ts` — AES-256-GCM key encryption/decryption
- `security-guards.test.ts` — role-based access control guards
- `security-middleware.test.ts` — rate limiting and auth middleware
- `security-headers.test.ts` — Content-Security-Policy and other response headers

### Unit tests

Pure function tests with no DB or network calls. Current files in `tests/unit/`:

- `shamir.test.ts` — Shamir secret sharing (split/combine)
- `wallet-verifiers.test.ts` — external wallet signature verification
- `attestation-encryption.test.ts` — attestation payload encryption
- `watermark.test.ts` — disclosure watermarking
- `session-keys.test.ts` — session key derivation

### Integration tests

Test real XRPC endpoints against a live server backed by PostgreSQL. Tests that create users require the PLC directory; those that don't (e.g., invite creation, admin login) skip the PLC check.

### E2E tests

Full multi-step journeys. Examples: vault recovery, wallet linking, encrypted attestation disclosure, governance proof verification. These always require both PostgreSQL and PLC.

---

## 4. Environment Setup

### Step 1 — Configure environment

```bash
cp .env.example .env
# Edit .env: set AUTH_JWT_SECRET, KEY_ENCRYPTION_SECRET, DB_*, etc.
```

Key variables needed for tests:

| Variable | Purpose |
|----------|---------|
| `AUTH_JWT_SECRET` | JWT signing (min 32 chars) |
| `KEY_ENCRYPTION_SECRET` | Signing/recovery key encryption |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | PostgreSQL connection |
| `PLC_DIRECTORY_URL` | PLC endpoint (default: `http://localhost:2582`) |
| `BOOTSTRAP_ADMIN_HANDLE` | Admin handle for test login (default: `admin`) |
| `BOOTSTRAP_ADMIN_PASSWORD` | Admin password for test login (default: `AdminPass1234`) |

### Step 2 — Initialize the database

```bash
# Option A: convenience script
./scripts/init-db.sh

# Option B: manually
psql -U postgres -c "CREATE DATABASE openfederation_test;"
psql -U postgres -d openfederation_test -f src/db/schema.sql
# Apply all migrations in order:
for f in scripts/migrate-*.sql; do psql -U postgres -d openfederation_test -f "$f"; done
```

### Step 3 — Seed the bootstrap admin

```bash
npm run db:seed-admin
```

### Step 4 — Start the PLC directory (for integration/E2E tests)

```bash
npm run plc:dev
# Runs on http://localhost:2582
```

### Step 5 — Build the project

```bash
npm run build
```

---

## 5. Writing Tests

### Integration tests (`tests/api/`)

Import helpers from `./helpers.js`. Tests share a single database and run sequentially.

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import {
  xrpcPost, xrpcAuthPost, xrpcGet, xrpcAuthGet,
  getAdminToken, createTestUser, isPLCAvailable, uniqueHandle,
} from './helpers.js';

describe('my endpoint', () => {
  let adminToken: string;
  let plcAvailable: boolean;

  beforeAll(async () => {
    adminToken = await getAdminToken();
    plcAvailable = await isPLCAvailable();
  });

  it('does something as admin', async () => {
    const res = await xrpcAuthPost('net.openfederation.invite.create', adminToken, { maxUses: 1 });
    expect(res.status).toBe(200);
  });

  it('creates a user (requires PLC)', async () => {
    if (!plcAvailable) return; // gate on PLC availability
    const user = await createTestUser(uniqueHandle('mytest'));
    expect(user.accessJwt).toBeTruthy();
  });
});
```

Key conventions:
- Gate PLC-dependent tests with `if (!plcAvailable) return;`
- Use `uniqueHandle('prefix')` to avoid handle collisions between test runs
- `createTestUser()` runs the full invite → register → approve → login flow

### Unit tests (`tests/unit/`)

No DB or PLC needed. Import directly from `src/` modules.

```typescript
import { describe, it, expect } from 'vitest';
import { splitSecret, combineShares } from '../../src/vault/shamir.js';

describe('shamir', () => {
  it('round-trips a secret', () => {
    const shares = splitSecret('my-secret', 3, 2);
    const recovered = combineShares(shares.slice(0, 2));
    expect(recovered).toBe('my-secret');
  });
});
```

### E2E tests (`tests/e2e/`)

Use composite helpers from `./helpers.js` (re-exports API helpers plus higher-level builders). Name test steps sequentially with `it('step N: description')` and share state at `describe` scope.

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import {
  getAdminToken, isPLCAvailable,
  createCommunityWithMember, issuePrivateAttestation, createOracleForCommunity,
} from './helpers.js';

describe('governance journey', () => {
  let adminToken: string;
  let communityDid: string;
  let ownerToken: string;

  beforeAll(async () => {
    const plcAvailable = await isPLCAvailable();
    if (!plcAvailable) return; // skip entire suite if PLC is down
    adminToken = await getAdminToken();
  });

  it('step 1: create community with member', async () => {
    const { communityDid: cDid, owner } = await createCommunityWithMember('gov');
    communityDid = cDid;
    ownerToken = owner.accessJwt;
    expect(communityDid).toMatch(/^did:plc:/);
  });

  it('step 2: create Oracle credential', async () => {
    const key = await createOracleForCommunity(adminToken, communityDid);
    expect(key).toMatch(/^ofo_/);
  });
});
```

---

## 6. Helpers Reference

### `tests/api/helpers.ts`

| Function | Signature | Description |
|----------|-----------|-------------|
| `xrpcPost` | `(nsid, body?)` | POST to XRPC endpoint without auth |
| `xrpcGet` | `(nsid, params?)` | GET from XRPC endpoint without auth |
| `xrpcAuthPost` | `(nsid, token, body?)` | POST to XRPC endpoint with Bearer token |
| `xrpcAuthGet` | `(nsid, token, params?)` | GET from XRPC endpoint with Bearer token |
| `getAdminToken` | `(): Promise<string>` | Login as bootstrap admin, return access JWT |
| `getAdminHandle` | `(): string` | Return bootstrap admin handle |
| `getAdminPassword` | `(): string` | Return bootstrap admin password |
| `isPLCAvailable` | `(): Promise<boolean>` | Check if PLC directory is reachable |
| `createTestUser` | `(handle, opts?)` | Full invite → register → approve → login flow |
| `uniqueHandle` | `(prefix?): string` | Generate a unique handle with timestamp suffix |

### `tests/e2e/helpers.ts`

Re-exports all of the above, plus:

| Function | Signature | Description |
|----------|-----------|-------------|
| `createCommunityWithMember` | `(prefix?): Promise<CommunityWithMember>` | Create community with owner and one joined member |
| `issuePrivateAttestation` | `(token, communityDid, subjectDid, subjectHandle, claim, accessPolicy?)` | Issue an encrypted private attestation |
| `createOracleForCommunity` | `(adminToken, communityDid, name?): Promise<string>` | Create Oracle credential, return raw key |

---

## 7. CI Behavior

GitHub Actions runs the security and integration tests on every push.

- **Test commands in CI:** `npm run test:unit` + `npm run test:api`
- **PostgreSQL service:** version 15, user `test`, password `test`, database `openfederation_test`
- **Schema initialization:** `psql -f src/db/schema.sql` followed by all `scripts/migrate-*.sql` files
- **Bootstrap admin:** seeded via `scripts/seed-bootstrap-admin.ts` (`npm run db:seed-admin`)
- **PLC directory:** not available in CI — tests gated with `isPLCAvailable()` skip gracefully
- **E2E tests:** not run in CI by default (require PLC)

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ECONNREFUSED` on port 2582 | PLC directory not running | `npm run plc:dev` |
| "Failed to get admin token" | Bootstrap admin not in DB | `npm run db:seed-admin` |
| "relation does not exist" | Missing migration(s) | Run all `scripts/migrate-*.sql` in order |
| Stale endpoint behavior | Old compiled output in `dist/` | `npm run build` |
| "Port 8080 in use" | Another PDS instance running | Kill the other process or change `PORT` in `.env` |
| Tests pass locally, fail in CI | PLC-dependent test not gated | Add `if (!plcAvailable) return;` guard |
| "KEY_ENCRYPTION_SECRET not set" | Missing env var | Set it in `.env` (any random 32+ char string for dev) |
