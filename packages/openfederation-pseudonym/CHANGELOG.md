# @open-federation/pseudonym

## 0.2.1

### Patch Changes

- db7b515: Passkey unlock works with password-manager extensions such as 1Password, which return the PRF output as a plain array. PRF output shorter than 32 bytes is refused with `PasskeyPrfUnsupported`, and the key always comes from a passkey sign-in, as unlocking does, so remembering a phrase asks for the passkey twice. Remember a phrase again if it was remembered with an earlier version.

## 0.2.0

### Minor Changes

- 9e7817f: Reveal bundles v2 (ADR-003): `createRevealBundle` returns `{ version: 2, owner: { did, keyRef, signingKey, signature } }` and takes an optional `ownerSigner`, so an owner who holds their own key (assisted or self custody) signs the link as the person; without it the owner's PDS signs (`keyRef: 'atproto'`), as before. `publishReveal` keeps `ownerSig` and adds `ownerKeyRef` and `ownerSignature`. New exported types `RevealBundleV1`, `RevealBundleV2`, `OwnerSignature`, `OwnerSigner`.
