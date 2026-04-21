# Sign In With OpenFederation — reference demo dApp

A minimal Vite + React app that exercises every consumer-facing piece of the OpenFederation web3 identity layer end-to-end:

- `@openfederation/sdk` for `createClient`, tier-1 wallet provisioning + signing, `signInWithOpenFederation`, and `verifySignInAssertion`.
- `@openfederation/react` for `OpenFederationProvider`, `useOFSession`, `useOFWallet`, and `<SignInWithOpenFederation>`.

Nothing here depends on a wallet extension, a wagmi connector, or solana-wallet-adapter. A freshly-signed-up user with no external wallet can produce an offline-verifiable `didToken` in three clicks.

## What it shows

1. **Login.** Standard `com.atproto.server.createSession` against your PDS.
2. **Auto-provision.** If the user has no wallet on the chosen chain, a Tier 1 (custodial) wallet is minted on demand and consent is granted to the demo origin.
3. **Sign-In With OpenFederation.** Two paths side-by-side — the programmatic `client.signInWithOpenFederation(...)` call, and the drop-in `<SignInWithOpenFederation>` component.
4. **Offline verification.** After success, the "Verify offline" button runs `verifySignInAssertion` right in the browser — resolving the issuer DID via the configured PLC directory / did:web, checking the JWT signature against the atproto key, and checking the wallet signature. Zero calls to OpenFederation are needed.
5. **Readable output.** Decoded JWT claims, raw `walletProof`, and the verifier's distilled result are rendered as JSON so you can see exactly what a dApp backend receives.

## Running

```bash
# First build the SDK + React package so the file: refs resolve.
npm --prefix packages/openfederation-sdk run build
npm --prefix packages/openfederation-react run build

# Then run the demo.
cd demos/siwof-dapp
npm install
npm run dev
```

Open <http://localhost:5173>, fill in your PDS URL + partner key + handle/password, and click "Sign in with OpenFederation."

## What you need

- A running OpenFederation PDS (see the repo root's README).
- An existing account on that PDS.
- A partner key with register permissions (any — the demo doesn't call `register`, but the SDK requires one in config).
