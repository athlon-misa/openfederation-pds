# Changelog

## 0.4.1

### Patch Changes

- db7b515: Passkey unlock works with password-manager extensions such as 1Password, which return the PRF output as a plain array. PRF output shorter than 32 bytes is refused with `PasskeyPrfUnsupported`, and the key always comes from a passkey sign-in, as unlocking does, so remembering a phrase asks for the passkey twice. Remember a phrase again if it was remembered with an earlier version.

## 0.4.0

### Minor Changes

- b83c7c1: Custody tiers are named for what they are (#239): every tier is custodial. `SecurityLevel.tierName` is now `'custodial' | 'escrow-recorded' | 'key-exported'` and `SecurityLevel.pdsHoldsRotationKey` is new. `exportRecoveryKey()` now returns the account's PLC rotation key (`rotationKey`, base64) instead of a single Shamir share that could not be used on its own; `registerEscrow()` returns `shareStoredHere: true`.
- 55a084b: `@open-federation/sdk/custody`: `buildCancelOp` cancels, within 72 hours, a PLC update signed by a lower-priority rotation key (an `assisted` account's own key undoing an update the server signed).
- a07c39a: New entry point `@open-federation/sdk/custody` (ADR-003): phrase keys for `assisted` and `self` accounts, did:plc genesis and custody-change operations, owner signatures (raw secp256k1/P-256 and WebAuthn passkey), and passkey unlock of the phrase. ESM and CommonJS only; the `/sdk/v1.js` browser bundle is unchanged.
- 2c1ccb9: `@open-federation/sdk/custody`: person-signed records (ADR-003, decision 11). `signRecord` / `signRecordWithPasskey` add `ownerSig` (the owner key's signature over the record's CID, DID and collection); `verifyOwnerRecord`, `recordCid` and `ownerRecordText` check it.
- d3d6c57: `@open-federation/sdk/custody`: `plcOperationSigner(op, rotationKeys)` names the rotation key that signed a PLC operation, so a client can tell a change the person made from one a lower key (the server's backup in `assisted`) made and the person may cancel.

## 0.3.0

### Minor Changes

- 22b6c94: Security release to match OpenFederation PDS 1.4.0.

  - **Breaking:** `wallet.grantConsent` is gone; the PDS no longer lets a dApp grant itself signing consent. Use `wallet.requestConsent` (returns an `approveUrl` on the PDS where the user approves with their password), then `wallet.waitForConsent` or `wallet.getConsentRequest`. Consents name `allowedContracts` and value limits.
  - **Breaking:** the ATProto login redirect requires `code_challenge`; the SDK sends one and binds the callback to the browser that started the login.
  - Partner registration tickets: `createPartnerTicket` and `generatePartnerTicketKey` for partners whose key requires a ticket.
  - Concurrent token refreshes are coordinated (two tabs or a transient failure no longer log the user out).
  - Byte-message signing fixed; `resolveWallet` is public; `sessionFromWrappedSecret` for Tier 2 wallets; SIWOF verification uses safer defaults (PLC directory list, timeout, IPv6 checks).

## 0.2.1

### Patch Changes

- 5950d8a: Guard outbound `did:web` resolution during offline sign-in verification (issue #97).

  `verifySignInAssertion` takes the issuer from an unverified JWT payload, so a caller could name any `did:web` host and make the verifying backend fetch it before any signature was checked — a blind SSRF primitive reaching internal HTTPS services and cloud metadata endpoints.

  The DID document fetch is now validated on every hop: HTTPS only, no embedded credentials, private/loopback/link-local/reserved addresses refused, redirects followed manually and re-validated rather than trusted, and the response bounded in both size and time. On Node the hostname is additionally resolved and every address it maps to is re-checked, which is the only way to catch a public name pointing inward.

  `did:web` remains fully supported — legitimate public issuers resolve exactly as before. `did:plc` resolution against the integrator-supplied `plcUrl` is deliberately unguarded, so self-hosted and local directories keep working.

  New optional `network` field on `VerifySignInOptions` tunes the timeout, response cap and redirect budget. The guard itself is not opt-in.

## 0.2.0

### Minor Changes

- c509f92: Protocol alignment with `@open-federation/lexicon@0.2.0` — semantic member classification (issue #50).

  ### What consumers should know

  The SDK does not currently wrap member endpoints, so **no API surface changes** in this release. This minor bump exists to:

  1. Align the SDK protocol version with lexicon 0.2.0 so downstream consumers that pin both packages upgrade together.
  2. Flag that the XRPC rename `community.updateMemberRole` → `community.updateMember` is **breaking for anyone using the SDK's raw `client.fetch(...)` escape hatch** to call the old NSID.

  ### Migration

  If your code looks like:

  ```ts
  await client.fetch("/xrpc/net.openfederation.community.updateMemberRole", {
    method: "POST",
    body: JSON.stringify({ communityDid, memberDid, role: "moderator" }),
  });
  ```

  Rename the NSID:

  ```diff
  - '/xrpc/net.openfederation.community.updateMemberRole'
  + '/xrpc/net.openfederation.community.updateMember'
  ```

  The new endpoint additionally accepts `kind`, `tags`, `attributes`, and `roleRkey` as optional partial-update fields. See the `@open-federation/lexicon@0.2.0` changelog for the full shape.

## 0.1.1

### Patch Changes

- 4b01450: Fix concurrent refresh-token calls causing accidental session revocation.

  When multiple requests hit an expired access token simultaneously, the SDK previously issued multiple refresh calls in parallel. The second call would replay an already-rotated refresh token, which the PDS treats as a compromise signal and revokes all user sessions.

  The client now deduplicates in-flight refresh attempts: concurrent callers share a single refresh promise, and the cached promise is cleared in `finally` so a rejection doesn't wedge future refreshes.

## 0.1.0

### Minor Changes

- 6ad63e8: Initial public release of the `@open-federation` package family under the newly-registered npm scope.

  ### `@open-federation/sdk`

  Full client library for OpenFederation PDSes — registration + login, session management, progressive-custody wallets (Tiers 1/2/3 with one-way upgrades), Sign-In With OpenFederation (CAIP-122), offline DID-based assertion verification, ethers v6 / Solana signer adapters, `mountSignInButton` vanilla DOM helper, `parseTokenExpiry` OAuth helper, and public DID→wallet resolution.

  ### `@open-federation/react`

  React bindings: `OpenFederationProvider`, `useOFSession`, `useOFWallet`, `useOFClient`, and a drop-in `<SignInWithOpenFederation>` component. React + `@open-federation/sdk` are peer dependencies; bundle is ~5KB ESM.

  ### `@open-federation/lexicon`

  ATProto Lexicon schemas for the OpenFederation protocol — consumed by TypeScript codegen downstream.

  ***

  **For downstream consumers:** replace any `file:` references to `@openfederation/*` (legacy in-code alias) with the registry name `@open-federation/*`. Minor bump because this is the inaugural public release; see individual package READMEs for the full API surface.

All notable changes to `@open-federation/sdk` will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Version Compatibility

The SDK is distributed via two channels:

| Channel                                  | URL / Install                      | Version                   |
| ---------------------------------------- | ---------------------------------- | ------------------------- |
| **IIFE bundle** (browser `<script>` tag) | `https://<pds>/sdk/v1.js`          | Tracks latest 0.x release |
| **npm package**                          | `npm install @open-federation/sdk` | Pinned to exact version   |

The `/sdk/v1.js` endpoint always serves the latest SDK built into the PDS.
The `v1` in the URL refers to the **API major version**, not the package version.
All `0.x` and `1.x` releases are backward-compatible within the `v1` endpoint.

When a breaking change requires a new major version, it will be served at `/sdk/v2.js`.
The previous endpoint will continue to work for a deprecation period.

### Stability Guarantees

- **Stable API surface** (will not break without a major version bump):

  - `createClient(config)` and all `ClientConfig` options
  - `register()`, `login()`, `logout()`, `getUser()`, `isAuthenticated()`
  - `fetch()`, `getAccessToken()`, `getSession()`, `onAuthChange()`
  - `displayHandle()`, `destroy()`
  - `loginWithATProto()`, `handleOAuthCallback()`
  - `verifyPdsToken()` (server-side)
  - All error classes: `OpenFederationError`, `AuthenticationError`, `ValidationError`, `ConflictError`, `RateLimitError`, `ForbiddenError`
  - `waitForSDK()` and the `openfederation:ready` DOM event

- **Internal / subject to change** (not part of the stable contract):
  - `TokenManager`, `StorageAdapter` implementations
  - `xrpcUrl()`, `errorFromResponse()`
  - Private class members

---

## [0.1.0] - 2025-05-01

### Added

- Initial release of `@open-federation/sdk`.
- `createClient(config)` factory function.
- Partner registration via `register({ handle, email, password })`.
- ATProto session login via `login({ identifier, password })`.
- Session management: `getUser()`, `isAuthenticated()`, `getAccessToken()`, `getSession()`.
- Automatic token refresh with configurable `autoRefresh` option.
- Auth state subscriptions via `onAuthChange(callback)`.
- Authenticated XRPC requests via `fetch(nsid, options)` with automatic 401 retry.
- `logout()` with server-side session invalidation.
- `displayHandle(handle)` for stripping PDS domain suffix.
- `loginWithATProto(handle | options)` for ATProto OAuth redirect.
- `handleOAuthCallback()` for completing OAuth login flow.
- `verifyPdsToken(token, options)` for server-side token verification.
- `destroy()` for cleanup of timers and callbacks.
- Typed error classes: `OpenFederationError`, `AuthenticationError`, `ValidationError`, `ConflictError`, `RateLimitError`, `ForbiddenError`.
- `AuthProvider` interface for cross-SDK interop.
- Storage backends: `localStorage` (default), `sessionStorage`, `memory`.
- IIFE bundle (`window.OpenFederation`) for zero-dependency browser usage.
- TypeScript type definitions (`.d.ts`) for ESM, CJS, and IIFE consumers.
- `waitForSDK(timeoutMs?)` helper for async/defer script loading.
- `openfederation:ready` custom DOM event fired on IIFE bundle load.
- `SDK_VERSION` constant.
