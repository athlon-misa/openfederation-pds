# Changelog

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
