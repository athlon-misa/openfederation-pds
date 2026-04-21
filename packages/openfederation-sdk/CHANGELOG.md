# Changelog

All notable changes to `@open-federation/sdk` will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Version Compatibility

The SDK is distributed via two channels:

| Channel | URL / Install | Version |
|---------|---------------|---------|
| **IIFE bundle** (browser `<script>` tag) | `https://<pds>/sdk/v1.js` | Tracks latest 0.x release |
| **npm package** | `npm install @open-federation/sdk` | Pinned to exact version |

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
