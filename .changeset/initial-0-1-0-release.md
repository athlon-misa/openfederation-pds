---
"@open-federation/sdk": minor
"@open-federation/react": minor
"@open-federation/lexicon": minor
---

Initial public release of the `@open-federation` package family under the newly-registered npm scope.

### `@open-federation/sdk`
Full client library for OpenFederation PDSes — registration + login, session management, progressive-custody wallets (Tiers 1/2/3 with one-way upgrades), Sign-In With OpenFederation (CAIP-122), offline DID-based assertion verification, ethers v6 / Solana signer adapters, `mountSignInButton` vanilla DOM helper, `parseTokenExpiry` OAuth helper, and public DID→wallet resolution.

### `@open-federation/react`
React bindings: `OpenFederationProvider`, `useOFSession`, `useOFWallet`, `useOFClient`, and a drop-in `<SignInWithOpenFederation>` component. React + `@open-federation/sdk` are peer dependencies; bundle is ~5KB ESM.

### `@open-federation/lexicon`
ATProto Lexicon schemas for the OpenFederation protocol — consumed by TypeScript codegen downstream.

---

**For downstream consumers:** replace any `file:` references to `@openfederation/*` (legacy in-code alias) with the registry name `@open-federation/*`. Minor bump because this is the inaugural public release; see individual package READMEs for the full API surface.
