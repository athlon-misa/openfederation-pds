# @open-federation/pseudonym

## 0.4.0

### Minor Changes

- 8d29bb0: Pen-name follow-ups (#412):

  - **A generic in-person proof context, named in the link.** `challengeForWord(word, context?)` defaults to the new `IN_PERSON_CONTEXT` (`'OpenFederation in-person proof'`) instead of requiring a context. `presenceLinkFragment` takes an optional `context` and writes it as `c=` (one line, at most 200 characters); `parseVerifyLink` returns it, and `verifyLink` checks a presence link in the context it names, so a link whose `c=` was changed is INVALID. A link without `c=`, as every link made before this version, is checked in `presenceContext`, which is now optional and defaults to the new `STAGE_PRESENCE_CONTEXT` (`'OpenNewsrooms stage challenge'`), so existing links keep verifying. The presence verdict now says which context it was checked in (`context`). Pass the context you signed with to `presenceLinkFragment`: a link that names none is read in the stage context.
  - **Moving into a PDS that asks for one of its own creation tokens** (`migration.pseudonyms: 'token'`): `moveAccount` and `openAccountForMove` take an optional `creationToken`, sent to `com.atproto.server.createAccount` as `token`. A refused token fails the `open` step, before anything changed.
  - **Publishing a reveal across servers:** `publishReveal` takes an optional `pseudonymPdsUrl` for a pseudonym that lives on another PDS than its owner (`pdsUrl`); each half is written at its own PDS with its own token. `revealLinkRecord(bundle)` returns the record it writes.

## 0.3.1

### Patch Changes

- 74896dd: The package now contains its code. Versions 0.1.0 to 0.3.0 were published without `dist/` (the release built the other packages but not this one), so importing them failed; use 0.3.1 or later.

## 0.3.0

### Minor Changes

- a602e62: A verifier that runs anywhere, including browsers and phones: `verifyRevealBundle` (online, it reports `ownerAttestation`: `person` when the owner's own key signed, `pds-held-key` when their server's did), `verifyPresence`, `checkPresence` and `fetchGenesisOp`, reading every key from the PLC directory. `challengeForWord(word, context)` turns a spoken word into a presence challenge. For QR codes, `revealLinkFragment` and `presenceLinkFragment` put a proof in a short URL fragment, `parseVerifyLink` and `revealBundleFromLink` read it back, and `verifyLink` checks it and names both accounts by handle.
- d974116: `tombstone({ plcUrl, did, phrase })` ends a pseudonym's DID in the PLC directory: it signs a `plc_tombstone` operation with the twelve words (the DID's only rotation key) and posts it, refusing first when the DID is already tombstoned or the words are not its rotation key. `buildTombstoneOp` and `signTombstoneOp` are exported too. Delete the pseudonym's accounts before tombstoning: servers check the owner-key JWT against the DID's current rotation keys.

## 0.2.1

### Patch Changes

- db7b515: Passkey unlock works with password-manager extensions such as 1Password, which return the PRF output as a plain array. PRF output shorter than 32 bytes is refused with `PasskeyPrfUnsupported`, and the key always comes from a passkey sign-in, as unlocking does, so remembering a phrase asks for the passkey twice. Remember a phrase again if it was remembered with an earlier version.

## 0.2.0

### Minor Changes

- 9e7817f: Reveal bundles v2 (ADR-003): `createRevealBundle` returns `{ version: 2, owner: { did, keyRef, signingKey, signature } }` and takes an optional `ownerSigner`, so an owner who holds their own key (assisted or self custody) signs the link as the person; without it the owner's PDS signs (`keyRef: 'atproto'`), as before. `publishReveal` keeps `ownerSig` and adds `ownerKeyRef` and `ownerSignature`. New exported types `RevealBundleV1`, `RevealBundleV2`, `OwnerSignature`, `OwnerSigner`.
