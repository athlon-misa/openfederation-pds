# @open-federation/pseudonym

Client library for OpenFederation pseudonyms: accounts that cannot be linked to their owner by the PDS, which the owner can later reveal (publicly, as a private file, or in person). The matching verifier is `ofc pseudonym verify` in the CLI. Server endpoints are listed in `docs/API.md`.

## Requirements

Install: `npm install @open-federation/pseudonym`.

The package depends on `@cloudflare/blindrsa-ts`, which declares `engines.node >= 24`. The OpenFederation PDS root declares `>=22 <25`, so run clients on Node 24 or newer.

## Collect tokens on a fixed schedule

Creating a pseudonym costs one blind creation token. Each approved account can collect one batch per UTC month (`PSEUDONYM_TOKENS_PER_EPOCH`, default 20). Call `collectTokens` on a fixed schedule (for example on every login) whether or not you need tokens, so a call reveals nothing. Fetch the epoch keys without credentials.

```ts
import { fetchTokenKeys, collectTokens } from '@open-federation/pseudonym';

const keys = await fetchTokenKeys(pdsUrl);                       // no credentials
const tokens = await collectTokens({ pdsUrl, accessJwt, keys, count: 20 });
// Store tokens on the device. Lost tokens are replaced only at the next epoch.
```

## Create a pseudonym

Call `createPseudonym` WITHOUT the owner's credentials (ideally over Tor). It generates a 12-word phrase on the device, reserves a signing key, registers the genesis operation in PLC and creates the account with one token. **The phrase is returned once and cannot be recovered. Show it to the user and make them store it.**

```ts
import { createPseudonym } from '@open-federation/pseudonym';

const { phrase, did, handle } = await createPseudonym({
  pdsUrl, plcUrl, pdsServiceUrl, handle: 'quiet-fox.example.net', ownerDid, token: tokens[0],
});
```

## Phrase login

```ts
import { loginWithPhrase } from '@open-federation/pseudonym';

const session = await loginWithPhrase({ pdsUrl, phrase }); // { did, handle, accessJwt, refreshJwt }
```

## Reveal

Revealing is always the owner's choice. Build a bundle with `createRevealBundle` (needs the phrase and the owner's session; the PDS signs the owner half through `signLink`), then pick a mode.

- **Public**: `publishReveal` writes a `net.openfederation.pseudonym.link` record into both the pseudonym's and the owner's repos.
- **Private file**: save the bundle as JSON and hand it to whoever should check it. They run `ofc pseudonym verify bundle.json --online`.
- **In person**: the verifier gives you a challenge (`ofc pseudonym presence-challenge`); you answer with `signPresence({ phrase, pseudonymDid, challenge })`; they run `ofc pseudonym verify-presence <did> <challenge> <signature>`. Nothing is published.

```ts
import { createRevealBundle, publishReveal, signPresence } from '@open-federation/pseudonym';

const bundle = await createRevealBundle({ pdsUrl, plcUrl, phrase, pseudonymDid, ownerDid, ownerAccessJwt });
await publishReveal({ pdsUrl, bundle, pseudonymAccessJwt, ownerAccessJwt });  // public mode
```

An offline check cannot tie the bundle's owner key to the owner's DID, so `ofc pseudonym verify` exits with code 2 until it is run with `--online`.

Lower-level helpers (formats, key derivation, token blinding, PLC genesis operations) are exported from the package root.

## Self-hosting privacy note

The PDS stores no pseudonym-to-owner pair and writes no audit entries for pseudonyms. It cannot control request logs outside its own code: hosting provider, reverse proxy and CDN logs are the operator's responsibility and must be configured (disabled or minimized, with short retention) by whoever runs the PDS. Requests made from the same address or at the same time can otherwise be correlated.
