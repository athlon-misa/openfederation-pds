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

`createPseudonym` throws if the PDS reports a different DID from the one the genesis operation produced.

## Phrase login

```ts
import { loginWithPhrase } from '@open-federation/pseudonym';

const session = await loginWithPhrase({
  pdsUrl, phrase,
  expectedServiceDid: 'did:web:pds.example.net', // the DID of the PDS you mean to log in to
}); // { did, handle, accessJwt, refreshJwt }
```

`expectedServiceDid` is required. The login message is signed over the service DID that the server's challenge names, so the client refuses to sign (and throws) when the challenge names any other service. Without this check a malicious server could relay another PDS's challenge and log in there as you. Pin the value in your app's configuration; do not take it from the server you are logging in to.

## Moving to another PDS

A pseudonym's owner key is its only PLC rotation key, so the owner can move it without help from the old PDS. The first step opens the account at the new PDS, deactivated:

```ts
import { openAccountForMove } from '@open-federation/pseudonym';

const opened = await openAccountForMove({
  newPdsUrl, newServiceDid: 'did:web:new-pds.example.net', // the PDS you are moving to
  phrase, did, handle: 'nightdesk.new-pds.example.net',  // a handle under the new PDS's domain
}); // { did, handle, signingKey, accessJwt, refreshJwt }
```

It reserves a signing key for the DID at the new PDS and calls `com.atproto.server.createAccount` with a short-lived JWT signed by the owner key (`signOwnerJwt`). Nothing changes for readers yet: the DID still points at the old PDS.

`moveAccount` runs the whole move in the standard AT Protocol order:

```ts
import { moveAccount } from '@open-federation/pseudonym';

const session = await moveAccount({
  oldPdsUrl, oldServiceDid, newPdsUrl, newServiceDid, plcUrl, phrase, did,
  newHandle: 'nightdesk.new-pds.example.net',
  onStep: (step) => show(step), // open, export, import, check, point, activate, retire (awaited)
}); // a session at the new home
```

It opens the account at the new PDS, copies the repository (`sync.getRepo` → `com.atproto.repo.importRepo`), and only signs the PLC update once the new PDS reports the exact repository the old one exported. The update uses the new PDS's recommended credentials (endpoint, signing key, handle) and keeps the rotation key and the commitment. Then it activates the account there, logs in, and deactivates the old account. A failure before the PLC update leaves the pseudonym working where it was. Blobs are not copied yet.

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

**What a reveal proves.** On OpenFederation PDSes the owner's root signing key is custodial: the PDS holds it and `signLink` signs with it. So a valid bundle, even one that passes the online check, proves that the owner's PDS signed the link and that the pseudonym's genesis commits to the owner's DID. It does not prove the person consented. The PDS operator, or anyone holding the database and `KEY_ENCRYPTION_SECRET`, can create a pseudonym whose genesis commits to any local account and have that account's key sign a link to it. Treat a reveal as "this PDS vouches for the link", and weigh it by how much you trust the PDS. A presence proof (`signPresence`) shows control of the pseudonym's phrase, not consent of the named owner either.

Lower-level helpers (formats, key derivation, token blinding, PLC genesis operations) are exported from the package root.

## Self-hosting privacy note

The PDS stores no pseudonym-to-owner pair and writes no audit entries for pseudonyms. It cannot control request logs outside its own code: hosting provider, reverse proxy and CDN logs are the operator's responsibility and must be configured (disabled or minimized, with short retention) by whoever runs the PDS. Requests made from the same address or at the same time can otherwise be correlated.
