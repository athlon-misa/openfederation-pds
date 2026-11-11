# ADR-003: Identity custody modes, custodial and self (#251)

**Status:** accepted, not built · **Decided:** 2026-10-19 · **Written down:** 2026-11-11 · **Issues:** #251 (daily unlock), #238 (recovery, later), #242 (write integrity)

One OpenFederation codebase serves two kinds of installation:

- **Community** (Grvty, sports): losing a key must not be catastrophic, so the PDS can
  always restore access.
- **Privacy** (OpenNewsrooms, journalists): the person, not the PDS, controls their
  identity. The PDS cannot move, rewrite or speak for the DID at the person level.

Identity stays core OpenFederation, managed by the PDS. Where keys are kept and how
backup is presented is up to each application.

## Where things stand

- **Every user account is custodial today.** The PDS keeps shares 2 and 3 of each user's
  PLC rotation key, enough to rebuild it. Since #357 the API says so: tiers are
  `custodial` / `escrow-recorded` / `key-exported`, `getSecurityLevel` reports
  `pdsHoldsRotationKey`, and `vault.exportRecoveryKey` hands the user the rotation key
  itself (a backup; the PDS keeps its copy).
- **Pseudonyms are already self-custodial.** A 12-word phrase on the device holds their
  keys; the PDS holds none. Daily unlock with a passkey is built for them
  (`rememberPhraseWithPasskey` / `unlockPhraseWithPasskey` in `@open-federation/pseudonym`).
- **The PDS can sign PLC updates** for custodial accounts (`signWithCustodialKey`, used by
  account moves, #266).
- **The repo signing key always stays with the PDS.** In AT Protocol the PDS signs every
  repo commit, so self-custody can never cover that key.

What this ADR adds: a `self` mode for ordinary accounts, where the PDS holds no rotation
key, and the same passkey unlock for them.

## Decisions

1. **Each account has a custody mode, `custodial` or `self`,** stored in
   `users.custody_mode`. Pseudonyms are `self` by construction.

2. **Each installation sets a policy through configuration.** A profile only supplies
   defaults; every setting can be overridden.

   | Setting | `community` | `privacy` | unset (today) |
   | --- | --- | --- | --- |
   | `IDENTITY_CUSTODY_ALLOWED` | `custodial,self` | `custodial,self` | `custodial,self` |
   | `IDENTITY_CUSTODY_DEFAULT` | `custodial` | `self` | `custodial` |
   | `PSEUDONYMS_ENABLED` | `false` | `true` | `true` |

   Select a profile with `OPENFEDERATION_PROFILE=community|privacy`.
   `net.openfederation.server.getPublicConfig` publishes the policy so applications can
   adapt onboarding. The default is a hint for applications; the PDS enforces only
   `ALLOWED`. A privacy installation **may** allow custodial accounts; its default is
   `self`.

3. **A `self` account has two user-held keys, both published in its DID document:**
   - **Rotation key:** the DID's only PLC rotation key. PLC needs plain signatures, which
     passkeys cannot make, so it is a software key: secp256k1 derived from a
     device-generated 12-word phrase at `m/1985'/0'`.
   - **Owner key:** the verification method `openfederation_owner`, which signs
     person-level statements (pseudonym links, consent, attestations). Either
     **secp256k1** from the same phrase (`m/1985'/1'`) or **P-256 from a passkey**
     (WebAuthn).

   The `atproto` repo signing key stays PDS-held, reserved through
   `com.atproto.server.reserveSigningKey`. The phrase never leaves the device.

4. **New `self` accounts:** the client builds and signs the genesis operation
   (`rotationKeys = [rotationKey]`, `verificationMethods = { atproto: reservedKey,
   openfederation_owner: ownerKey }`) and submits it to PLC. It then calls
   `net.openfederation.account.registerSelfCustody`, which applies the same rules as
   `account.register` (invite, email, password, approval) plus the DID. The PDS checks the
   genesis operation as it does for pseudonyms. **Login stays password-based:** custody
   is about keys, not sessions.

5. **Upgrading `custodial` → `self`: two steps, never reversed.**
   - `identity.prepareCustodyUpgrade` (password, plus the new rotation-key and owner-key
     `did:key`s) returns the exact unsigned PLC update: `prev` = the current head,
     `rotationKeys = [newRotationKey]`, the same `atproto` key, services and alsoKnownAs,
     plus `openfederation_owner`.
   - `identity.finalizeCustodyUpgrade` (password, the same keys, the operation's CID, and
     proof-of-possession signatures from both new keys over that CID):
     1. The PDS rebuilds the operation and checks the CID.
     2. It checks both possession signatures.
     3. It rebuilds its rotation key from shares 2 + 3, signs and submits the operation.
     4. It reads the result back from PLC.
     5. Only then does it delete the vault shares and set `custody_mode = 'self'`.

     Finalize is **idempotent**: if PLC already shows the result, it completes the
     database step.

   There is no downgrade, matching wallets: going back would mean trusting the PDS again.

6. **Restrictions on `self` accounts:**
   - The vault endpoints (`requestShareRelease`, `exportRecoveryKey`, `registerEscrow`)
     refuse with `SelfCustodyAccount`.
   - `pseudonym.signLink` refuses with `SelfCustodyAccount` ("sign with your owner key").
   - `account.getSecurityLevel` reports `custodyMode`.
   - Password reset still works: it only restores the login. A stolen password lets an
     attacker post through the PDS, but **not** move the DID or make owner signatures.

7. **Owner signatures have two formats**, both checked by one core function,
   `verifyOwnerSignature`, and both produced by the client package:
   - `raw`: secp256k1 or P-256, low-S, compact 64 bytes, over `sha256(utf8(text))`.
   - `webauthn`: a passkey assertion whose `clientDataJSON.type` is `webauthn.get` and
     whose `challenge` is `base64url(sha256(utf8(text)))`, with the user-present flag set;
     ECDSA P-256 (DER) over `authenticatorData ‖ sha256(clientDataJSON)`. Origin and rpId
     are reported, not enforced.

8. **Pseudonym reveal bundles v2:** `owner = { did, keyRef: 'openfederation_owner' |
   'atproto', signingKey, signature: { format: 'raw' | 'webauthn', … } }`.
   - Offline, the owner key is reported as unchecked, as today.
   - Online, the key is resolved under `keyRef` in the owner's DID document. With
     `openfederation_owner` the verdict says **"the person controlling <owner> signed"**;
     with `atproto` it keeps the custodial wording ("<owner>'s PDS-held key signed").
   - v1 bundles still verify, with custodial wording.

9. **Client code goes in `@open-federation/sdk/custody`**, a subpath: key generation, PLC
   operations, passkey helpers, owner signing. It is not in the `/sdk/v1.js` IIFE bundle,
   so Grvty and FlappySoccer bundles do not change. `@open-federation/pseudonym` uses the
   subpath for owner signing.

10. **No recovery for `self` accounts in v1.** #238 tracks later options, none of which
    gives the PDS recovery power.

11. **Person-signed records** (option 1 of the write-integrity milestone, #242). The PDS
    holds the repo key, so it can write records as a user. Records that matter can carry
    an owner signature the PDS cannot produce:
    - Field `ownerSig: { cid, signature: OwnerSignature }`, an extra field; AT Protocol
      allows unknown fields, so generic apps ignore it.
    - `cid` is the CID of the record **without** `ownerSig` (dag-cbor, sha256, CIDv1).
    - Signed text, binding DID and collection so the signature cannot be copied elsewhere:
      ```
      OpenFederation Owner Record v1
      did: <did>
      collection: <nsid>
      cid: <cid>
      ```
    - A record is *person-signed* when `ownerSig.cid` matches the recomputed CID and the
      signature verifies with the DID document's `openfederation_owner` key.
    - Tools: SDK `signRecord` / `verifyOwnerRecord`; core `verifyOwnerSignedRecord`; a
      public `net.openfederation.identity.verifyRecord` for apps that don't resolve DIDs;
      the authorship-claim lexicon declares `ownerSig` as optional.
    - Apps show "signed by the person" only for verified records. Forgery becomes
      detectable and provable, not prevented. Options 2 (#240) and 3 (#241) are decided
      later.

12. **Daily unlock (#251): the phrase once per device, a passkey every day.**
    - Setting up or recovering a device: type the phrase once.
    - The device stores the phrase encrypted, with a key from a passkey through the
      WebAuthn PRF extension. The phrase is never stored in the clear; the PDS never sees
      it or the passkey secret.
    - Daily login: Face ID, Touch ID, Windows Hello or a security key unlocks the phrase
      on the device; phrase-based operations then run unchanged.
    - Client-only, no PDS changes: `rememberPhraseWithPasskey` / `unlockPhraseWithPasskey`,
      already in `@open-federation/pseudonym`, and also in `@open-federation/sdk/custody`
      for `self` accounts.
    - Where the encrypted phrase is kept is the app's choice; the helpers return a small
      blob.
    - No PRF support in the browser or authenticator: keep using the phrase, never a
      weaker secret (no PIN, no "5th word", no TOTP; the issue explains why each fails).
    - One passkey per pseudonym, so nothing links two of them; apps name passkeys
      neutrally and let the user choose a device-only key over a synced one.
    - Losing the device is not losing the identity: the paper phrase restores it.

## Out of scope

- Self-custody of the repo signing key (impossible in AT Protocol).
- Recovery for `self` accounts (#238).
- Rotating keys on a `self` account after creation. The user can sign PLC operations with
  their rotation key; a client helper for it is a follow-up.

## Known limits

- **Whoever has a `self` account's phrase controls the DID**, and there is no recovery.
- **The PDS still holds the repo key.** It can write records as the user (made detectable
  by decision 11), but it cannot make owner signatures or change the DID.
- **A passkey owner key is tied to one application's domain** (its rpId), so another
  application cannot sign with it. Owner keys from the phrase work anywhere.

## Order of work

1. Policy and `custody_mode` (decisions 1, 2, 6), with `getPublicConfig` and
   `getSecurityLevel` reporting them.
2. `@open-federation/sdk/custody`: phrase keys, PLC genesis and update operations, owner
   signing in both formats, passkey unlock (decisions 3, 7, 9, 12).
3. `registerSelfCustody` (decision 4).
4. The custodial → self upgrade (decision 5).
5. Reveal bundles v2 (decision 8), then person-signed records (decision 11).
