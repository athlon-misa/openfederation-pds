# Security Hardening Plan C: API Safety, AP Fix, CLI, Documentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix AP RSA key persistence, add transfer confirmation, partner key domain verification, OAuth redirect warning, admin identity verification, rotation key phishing warning, and invite --bound-to.

**Architecture:** These are independent features that can be implemented in any order. Each task is self-contained.

**Tech Stack:** TypeScript, PostgreSQL, Express.js, Node.js crypto

**Depends on:** Plan A should be deployed first. Plan B (email service) is needed for the admin identity verification task (nonce challenge via email).

---

## Task 1: Persist AP RSA keys in database

**Problem:** `src/activitypub/ap-routes.ts` computes a seed from community DID + secret but never uses it. Keys are generated randomly on every restart, breaking AP federation.

**New files:**
- `scripts/migrate-011-ap-keys.sql` — `ap_signing_keys` table (did, public_key_pem, encrypted_private_key, created_at)

**Modified files:**
- `src/activitypub/ap-actors.ts` or `src/activitypub/ap-routes.ts` — generate RSA key once, persist in DB, load on subsequent requests
- Cache in memory per DID (existing pattern)

**Scope:**
- On first AP actor request for a DID: generate RSA-2048 keypair, encrypt private key at rest with `encryptKeyBytes()`, store in `ap_signing_keys`
- On subsequent requests: load from DB (with in-memory cache)
- Keys survive restarts and are consistent across instances

## Task 2: Community transfer confirmation

**Modified files:**
- `src/api/net.openfederation.community.transfer.ts` — require `password` field for re-authentication
- `cli/ofc.ts` — add `--confirm` flag to transfer command, prompt for password

**Scope:**
- API: require `password` field in transfer request body. Verify against user's password hash before proceeding.
- CLI: `ofc community transfer <did> --new-owner <did> --confirm` — without `--confirm`, show warning and exit. With `--confirm`, prompt for password.
- Audit log entry already exists (`community.transfer.initiate`)

## Task 3: Partner key domain verification

**Modified files:**
- `src/api/net.openfederation.partner.createKey.ts` — make `allowed_origins` required (not optional)
- `src/auth/partner-guard.ts` — enforce origin check always (not just when origins are configured)

**Scope:**
- When creating a partner key, `allowedOrigins` must be non-empty (at least one domain)
- Default rate limit for new keys set low (10/hr) — admin must explicitly increase
- Document vetting process in deployment docs

## Task 4: OAuth redirect phishing warning

**Modified files:**
- `src/oauth/external-routes.ts` — render intermediate confirmation page before redirect

**Scope:**
- Before redirecting to external PDS for OAuth, render a minimal HTML page showing:
  - The full PDS URL the user will be sent to
  - A warning to verify this is their home PDS
  - A "Continue" button that proceeds with the redirect
  - A "Cancel" link that returns to the login page
- If the handle domain doesn't match the PDS service endpoint domain, show a visual warning

## Task 5: Admin identity verification protocol

**Modified files:**
- `cli/ofc.ts` — add `ofc admin account verify <handle>` command

**New files:**
- `src/api/net.openfederation.admin.createVerificationChallenge.ts`
- `src/api/net.openfederation.admin.verifyChallenge.ts`

**Scope:**
- `createVerificationChallenge`: admin requests a nonce for a user. Nonce stored in DB with 10-minute expiry. Nonce sent to user's email (requires Plan B email service).
- `verifyChallenge`: user signs the nonce with their DID signing key, admin submits the signature. Server verifies signature matches the user's signing key.
- Only after successful verification should admin proceed with password reset or other sensitive operations.
- Document in deployment docs: "Never reset a password based solely on an email request."

## Task 6: Rotation key phishing warning

**Modified files:**
- `src/api/net.openfederation.community.create.ts` — update the `response.message` text
- `web-interface/src/components/rotation-key-modal.tsx` — update the warning text

**Scope:**
- API message: add "OpenFederation and PDS operators will NEVER ask you for this key. Any request for it is a phishing attempt."
- Web UI modal: add the same warning prominently
- Also mention in the CLI output if community creation shows the key there

## Task 7: Invite --bound-to

**Modified files:**
- `src/api/net.openfederation.invite.create.ts` — add optional `boundTo` and `note` fields
- `src/api/net.openfederation.account.register.ts` — validate `boundTo` match
- `src/db/schema.sql` — add `bound_to` and `note` columns to invites table
- `scripts/migrate-012-invite-binding.sql` — ALTER TABLE
- `cli/ofc.ts` — add `--bound-to <email>` and `--note <text>` to invite create

**Scope:**
- When `boundTo` is set on an invite, registration verifies that the registering email matches (case-insensitive)
- `note` is a free-text field for admin context ("Invited by Bob from team meeting")
- Both fields optional for backwards compatibility

## Task 8: Integration tests + verification

**Scope:**
- Tests for transfer re-authentication
- Tests for invite binding
- Tests for partner key origin requirement
- CI verification
