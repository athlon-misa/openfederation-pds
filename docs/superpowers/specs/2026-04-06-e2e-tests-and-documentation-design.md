# E2E Tests & Test Documentation — Design Spec

**Date:** 2026-04-06
**Status:** Approved

## Goal

Add end-to-end tests for all 7 new features (Issues #31–#38) and create comprehensive test documentation. E2E tests exercise full multi-step user journeys, not just individual endpoints.

## Test Structure

```
tests/
├── e2e/
│   ├── helpers.ts                            # E2E helpers (reuses api/helpers.ts, adds composites)
│   ├── wallet-linking.e2e.test.ts            # Per-feature: full wallet link journey
│   ├── vault-recovery.e2e.test.ts            # Per-feature: vault + recovery tiers
│   ├── encrypted-attestations.e2e.test.ts    # Per-feature: private attestation lifecycle
│   ├── disclosure-proxy.e2e.test.ts          # Per-feature: grant → redeem → revoke
│   ├── chain-proof-verification.e2e.test.ts  # Per-feature: adapter → verify → cache
│   ├── lexicon-revisions.e2e.test.ts         # Per-feature: validate all lexicons have revision
│   ├── identity-wallet-recovery.e2e.test.ts  # Cross-cutting: identity + wallet + vault + recovery
│   ├── attestation-disclosure.e2e.test.ts    # Cross-cutting: community + attestation + proxy
│   └── governance-proofs.e2e.test.ts         # Cross-cutting: governance + oracle + cache
```

**Infrastructure:**
- Same vitest suite as existing tests — `tests/e2e/` added to vitest.config.ts includes
- New npm script: `test:e2e` runs `vitest run tests/e2e/`
- All E2E tests gated on `isPLCAvailable()` — skip gracefully when infra isn't running
- `e2e/helpers.ts` re-exports from `api/helpers.ts` and adds composite helpers:
  - `createCommunityWithMember(ownerToken)` — creates community, adds member, returns both
  - `issuePrivateAttestation(ownerToken, communityDid, subjectDid, claim, accessPolicy)` — issues + returns rkey
  - `createOracleForCommunity(adminToken, communityDid)` — creates Oracle credential, returns key

## Per-Feature E2E Flows

### wallet-linking.e2e.test.ts
1. Register user
2. Request challenge (Ethereum)
3. Sign challenge with ethers Wallet
4. Link wallet
5. List wallet links — verify wallet present
6. Resolve wallet by address — verify returns user DID
7. Unlink wallet
8. Confirm resolve returns 404

### vault-recovery.e2e.test.ts
1. Register user (receives deviceShare in identity creation)
2. Verify vault shares exist via audit log endpoint
3. Check security level — assert Tier 1, vaultShares: true, escrowRegistered: false
4. Register escrow provider
5. Check security level — assert Tier 2, escrowRegistered: true
6. Request share release (requires identity verification flow)
7. Verify returned share is valid Shamir share string

### encrypted-attestations.e2e.test.ts
1. Create community with member
2. Issue public attestation — verify unchanged behavior
3. Issue private attestation
4. Verify commitment — hash present, no claim content
5. Subject creates viewing grant
6. Check grant status — active
7. Revoke grant — verify status reflects

### disclosure-proxy.e2e.test.ts
1. Create community with member
2. Issue private attestation
3. Subject creates viewing grant for third user
4. Third user redeems grant — gets session-encrypted watermarked content
5. Check disclosure audit log — confirm `redeem` entry with watermarkId
6. Revoke grant
7. Confirm redeem fails with 403

### chain-proof-verification.e2e.test.ts
1. Register mock chain adapter in test setup
2. Submit proof via Oracle key — verify verified: true, cached: false
3. Submit same proof again — verify cached: true
4. Submit proof for unregistered chain — verify oracle-trust fallback

### lexicon-revisions.e2e.test.ts
1. Read all lexicon JSON files from src/lexicon/
2. Verify every file has revision integer >= 1
3. Verify issueAttestation has revision 2 (the only bumped schema)

## Cross-Cutting E2E Flows

### identity-wallet-recovery.e2e.test.ts
1. Register user — confirm deviceShare returned
2. Link Ethereum wallet — verify in listWalletLinks
3. Get security level — Tier 1, vaultShares: true, escrowRegistered: false
4. Register escrow — security level becomes Tier 2
5. Initiate identity verification (createVerificationChallenge + verifyChallenge)
6. Export recovery key — get Share 2, assert Tier 3
7. Combine deviceShare + exported Share 2 via combineShares() — verify reconstructs valid key buffer

### attestation-disclosure.e2e.test.ts
1. Create community with owner + member
2. Issue public attestation — verify via verifyAttestation (existing endpoint)
3. Issue private attestation with accessPolicy: { rules: [{ type: 'did-allowlist', dids: [memberDid] }] }
4. Verify commitment — hash present, no claim content
5. Member requests disclosure — succeeds
6. Non-member requests disclosure — 403
7. Subject creates 60-min viewing grant for third user
8. Third user redeems grant — session-encrypted watermarked content
9. Check disclosure audit log — confirm redeem entry
10. Subject revokes grant — redeem fails 403

### governance-proofs.e2e.test.ts
1. Create community with on-chain governance model
2. Create Oracle credential
3. Submit proof with Oracle key (mock adapter)
4. Verify verified: true, cached: false, verificationMethod: on-chain
5. Submit identical proof — cached: true
6. Submit for unregistered chain — oracle-trust fallback

## Test Documentation

### tests/README.md
Comprehensive guide covering:
1. **Prerequisites** — Node.js 18+, PostgreSQL 15, PLC directory
2. **Quick Start** — 4 commands for each suite
3. **Test Suites** — table: suite name, npm script, what it covers, required infrastructure
4. **Environment Setup** — env vars, DB init, PLC startup, bootstrap admin
5. **Writing Tests** — patterns for API tests, unit tests, E2E tests, isPLCAvailable gate
6. **Helpers Reference** — table of all helper functions with signatures
7. **CI Behavior** — GitHub Actions pipeline, DB setup, skip behavior
8. **Troubleshooting** — PLC not running, missing migrations, stale dist/, ports

### CLAUDE.md Updates
- Fix test count (outdated "77 tests across 7 test files")
- Add `test:e2e` to development commands
- Document E2E prerequisites

## npm Scripts

```json
"test:e2e": "vitest run tests/e2e/"
```

vitest.config.ts updated to include `tests/e2e/**/*.test.ts`.
