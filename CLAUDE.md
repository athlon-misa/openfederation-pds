# OpenFederation PDS

Personal Data Server for OpenFederation. Identity / auth provider for the multi-repo project; downstream consumers depend on this repo's `@open-federation/sdk` and PDS API.

**Core principle:** AT Protocol compatibility is non-negotiable — only extend, never replace. Adhere to the design decisions in `Identity_Layer_Specification.md`.

## Where things live

- **API endpoint reference:** `docs/API.md`
- **What's already shipped (subsystem inventory):** `docs/IMPLEMENTATION_STATUS.md`
- **Release notes:** `CHANGELOG.md`
- **Database schema:** `src/db/schema.sql` (auto-applied on startup); incremental migrations in `scripts/migrate-NNN-*.sql`
- **Lexicons:** `src/lexicon/*.json`
- **CLI:** `cli/README.md`
- **SDK integration:** `docs/sdk-integration-guide.md`
- **Deployment:** `RAILWAY.md`, `DEPLOYMENT.md`

## Development

```bash
npm install
./scripts/init-db.sh
npm run dev               # PDS server (port 8080)
npm run plc:dev           # Local PLC directory (port 2582) — required for E2E
npm run build             # Compiles PDS, builds SDK to dist/sdk/v1.js
npm run cli -- <command>  # CLI (build first)

npm test                  # Security tests
npm run test:api          # Integration + unit
npm run test:e2e          # E2E (needs PLC running + seeded DB; see tests/README.md)
npm run lexicon:validate  # Run before committing lexicon changes
```

Always rebuild **and restart** after backend changes — stale `dist/` is the most common cause of "method not found".

## Required environment variables

See `.env.example` for the full list. Critical ones:

| Variable | Required | Notes |
|----------|:---:|-------|
| `AUTH_JWT_SECRET` | Production | ≥32 random chars; server refuses to start in production without it |
| `KEY_ENCRYPTION_SECRET` | Production | Required before creating communities; encrypts recovery + signing keys at rest |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | Yes | Postgres connection |
| `DB_SSL` | Production | Set to `true` |
| `PLC_DIRECTORY_URL` | No | Default `http://localhost:2582` (dev). Production: `https://plc.openfederation.net` |
| `PDS_SERVICE_DID` | No | Inbound service-auth `aud` claim; default `did:web:{PDS_HOSTNAME}` |
| `CHAIN_ADAPTERS` | No | Treat as secret — contains RPC API keys. Format: `eip155:137=https://rpc.example.com` |
| `SERVICE_AUTH_RATE_LIMIT` | No | Default 60/min/DID |
| `WALLET_SIGN_RATE_LIMIT` | No | Default 60/min/IP |
| `CREATE_RATE_LIMIT` | No | Default 10/hr/IP for invites/communities/wallets/consents |
| `EXPRESS_TRUST_PROXY` | No | Default 1; set to 2 for Cloudflare + proxy |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` | No | Email logged to console when unset |

## Security imperatives

- **NEVER store the user's primary `did:plc` rotation key.** Return it on creation, then discard from memory.
- Recovery + signing keys are encrypted at rest with AES-256-GCM (PBKDF2 100k iter, SHA-512) keyed off `KEY_ENCRYPTION_SECRET`.
- Refresh token rotation has reuse detection — replaying a rotated token revokes ALL sessions for that user.
- Rate limiting is applied globally and per-endpoint; never weaken the auth/registration limits.
- Failed logins use exponential lockout: 5/10/15/20 failures → 1m/5m/30m/2h.
- All admin and security-relevant actions log to `audit_log` (actor, target, action, metadata).
- Cross-PDS service-auth: ES256K/ES256 verified against issuer DID's atproto signing key (`@atproto/identity` resolver, 5-min cache, signature replay cache, per-DID rate limit). External callers get `authMethod: 'service-auth'` with empty roles.

## Library quirks worth remembering

- **PLC client (`src/identity/plc-client.ts`):** implements the PLC protocol directly using `@ipld/dag-cbor` + `@atproto/crypto`. We do NOT use `@did-plc/lib` — incompatible `@atproto/crypto` (0.1.0 vs 0.4.5) and `multiformats` (9 vs 13) versions. `dag-cbor` is CJS-only, imported via `createRequire()`.
- **TIDs / CIDs:** `TID.nextStr()` from `@atproto/common-web`, `cidForRecord()` from `@atproto/repo` — both ATProto-compliant.
- **Real MST repos:** `RepoEngine` (`src/repo/repo-engine.ts`) wraps `@atproto/repo`'s `Repo` class; `PgBlockstore` implements `RepoStorage` on Postgres. `SimpleRepoEngine` is deprecated.
- **`getKeypairForDid()`** loads encrypted signing key → `Secp256k1Keypair`; checks `signing_keys` first, falls back to `user_signing_keys`.
- **OAuth provider imports:** all types from `@atproto/oauth-provider` use the main package entry, NOT deep `dist/` paths.
- **`createSession.ts`:** rejects `auth_type='external'` users with "Use ATProto OAuth" error.
- **External users:** `auth_type='external'`, `password_hash=NULL`, `status='approved'`, `pds_url` set.
- **`repo_blocks` and `records_index`** have NO FK to `communities(did)` — they store both user and community repo data.
- **Bootstrap admin** stays local-only: no PLC registration, no repo. `createLocalDid()` (formerly `createAccountDid()`) is admin-only.

## Lexicon revision policy

Every `src/lexicon/*.json` must contain a `"revision"` integer field (≥1) immediately after `"id"`.
- Bump `revision` by 1 whenever inputs, outputs, or errors change — additions and breaking changes alike.
- New schemas start at `"revision": 1`.
- `npm run lexicon:validate` before committing.
- The docs builder (`npm run build:lexicon-docs`) renders the revision next to each schema heading.

## Multi-repo coordination

This repo owns: PDS API server, `@open-federation/sdk`, PLC directory service, Web UI admin dashboard. Bugs/features in any of those are fixed here directly.

This repo has **no dependencies on sibling repos** — it is the upstream identity provider.

**Downstream consumers:**
- [grvty-leaderboards](https://github.com/athlon-misa/grvty-leaderboards) — uses `@open-federation/sdk` via `@grvty/identity`
- [FlappySoccer](https://github.com/athlon-misa/flappysoccer) — uses `@open-federation/sdk` IIFE bundle from `/sdk/v1.js`

**Topology:** `.multi-repo-manifest.json`. Glossary: [grvty-shared/docs/UBIQUITOUS_LANGUAGE.md](https://github.com/athlon-misa/grvty-shared/blob/main/docs/UBIQUITOUS_LANGUAGE.md).

### Cross-repo routing

When a bug or change request actually belongs in a downstream consumer:

1. **Do NOT fix it here.** Game logic, leaderboard service code, etc. live in their own repos.
2. **Draft a GitHub issue** against the correct downstream repo. Always show the full preview and ask for confirmation before filing.
3. **`gh issue create`** defaults: labels `cross-repo` plus `bug` / `enhancement` / `breaking-change`. Body must include consumer repo + URL, SDK version, repro steps, expected vs actual.

When you see `cross-repo`-labeled issues filed against this repo from sibling agents: treat as high-priority, reference the original issue number in the PR, and notify the user after fixing so the downstream repo can update its dependency.
