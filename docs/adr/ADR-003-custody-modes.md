# ADR-003: Identity custody modes, custodial and self (#251)

**Status:** accepted, built (#361–#366 and the person-signed records PR) · **Decided:** 2026-10-19 · **Written down:** 2026-11-11 · **Revised:** 2026-11-11 (the `assisted` mode; changing modes goes both ways; password reset) · **Issues:** #251 (daily unlock), #238 (recovery, later), #242 (write integrity)

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

What this ADR adds: `self` and `assisted` modes for ordinary accounts, changing between
modes, and the same passkey unlock for them.

## How PLC rotation keys decide who controls a DID

A DID's PLC document lists its rotation keys **in priority order**. Any listed key can sign
an update. A key higher in the list can also **cancel** an update signed by a lower key, if
it acts within **72 hours** of that update. The modes below are nothing more than who holds
which key, and in what order.

## Decisions

1. **Each account has a custody mode,** stored in `users.custody_mode`:

   | Mode | Rotation keys in the DID, by priority | Who can change the DID | If the phrase is lost |
   | --- | --- | --- | --- |
   | `custodial` | the PDS's key | the PDS | nothing is lost: the user has no phrase |
   | `assisted` | 1. the user's key, 2. the PDS's key | the user; the PDS too, but the user can cancel the PDS's change within 72 hours | the PDS recovers the account |
   | `self` | the user's key | only the user | the DID can never change again (#238) |

   Pseudonyms are `self` by construction. `assisted` is the AT Protocol recommendation of
   adding your own key above the PDS's: the PDS remains a safety net, and the person keeps
   a veto over it.

2. **Each installation sets a policy through configuration.** A profile only supplies
   defaults; every setting can be overridden.

   | Setting | `community` | `privacy` | unset (today) |
   | --- | --- | --- | --- |
   | `IDENTITY_CUSTODY_ALLOWED` | `custodial,assisted,self` | `custodial,assisted,self` | `custodial,assisted,self` |
   | `IDENTITY_CUSTODY_DEFAULT` | `custodial` | `self` | `custodial` |
   | `PSEUDONYMS_ENABLED` | `false` | `true` | `true` |

   Select a profile with `OPENFEDERATION_PROFILE=community|privacy`.
   `net.openfederation.server.getPublicConfig` publishes the policy so applications can
   adapt onboarding. The default is a hint for applications; the PDS enforces only
   `ALLOWED`. A privacy installation **may** allow custodial accounts; its default is
   `self`.

3. **`assisted` and `self` accounts have two user-held keys, both published in the DID
   document:**
   - **Rotation key:** the user's PLC rotation key (in `assisted`, the first of two). PLC
     needs plain signatures, which passkeys cannot make, so it is a software key:
     secp256k1 derived from a device-generated 12-word phrase at `m/1985'/0'`.
   - **Owner key:** the verification method `openfederation_owner`, which signs
     person-level statements (pseudonym links, consent, attestations). Either
     **secp256k1** from the same phrase (`m/1985'/1'`) or **P-256 from a passkey**
     (WebAuthn).

   In `assisted` the PDS also holds a rotation key, kept as shares 2 and 3 as for
   custodial accounts, listed second. The `atproto` repo signing key stays PDS-held in
   every mode, reserved through `com.atproto.server.reserveSigningKey`. The phrase never
   leaves the device.

4. **New `assisted` and `self` accounts:** the client builds and signs the genesis
   operation (`rotationKeys = [rotationKey]` for `self`, `[rotationKey, pdsKey]` for
   `assisted`, where the PDS makes `pdsKey` and returns its `did:key` first;
   `verificationMethods = { atproto: reservedKey, openfederation_owner: ownerKey }`) and
   submits it to PLC. It then calls `net.openfederation.account.registerSelfCustody` with
   the mode. That endpoint applies the same rules as `account.register` (invite, email,
   password, approval) plus the DID. The PDS checks the genesis operation as it does for
   pseudonyms, including that the rotation keys are exactly what the mode says. **Login
   stays password-based:** custody is about keys, not sessions (decision 6).

5. **Changing modes works in every direction; a password alone never changes one.** Every
   change is one PLC update. The rule for who signs it:

   | From → to | Signed by | Also needs |
   | --- | --- | --- |
   | `custodial` → `assisted` / `self` | the PDS's key (the only one there is) | password, and proof that the user holds the new keys (below) |
   | `assisted` → `self` | the user's key | nothing: the user can do this alone at PLC; the PDS deletes its shares once PLC shows the change |
   | `self` → `assisted` / `custodial` | the user's key | the PDS makes a **new** rotation key (shares 2 and 3) for the user to add |
   | `assisted` → `custodial` | the user's key | the user's key is removed; only the PDS's stays |

   **Towards the person** (`custodial` → `assisted` / `self`), as originally decided:
   - `identity.prepareCustodyChange` (password, target mode, the new rotation-key and
     owner-key `did:key`s) returns the exact unsigned PLC update: `prev` = the current
     head, the new `rotationKeys`, the same `atproto` key, services and alsoKnownAs, plus
     `openfederation_owner`.
   - `identity.finalizeCustodyChange` (password, the same keys, the operation's CID, and
     proof-of-possession signatures from both new keys over that CID):
     1. The PDS rebuilds the operation and checks the CID.
     2. It checks both possession signatures.
     3. It rebuilds its rotation key from shares 2 + 3, signs and submits the operation.
     4. It reads the result back from PLC.
     5. Only then does it update `custody_mode`, and for `self` deletes the vault shares.

   **Towards the PDS** (`self` → `assisted` / `custodial`, `assisted` → `custodial`): the
   same two calls, but the user signs. `prepare` (password, target mode) makes the PDS's
   new rotation key if needed, stores it as pending shares, and returns the unsigned
   update. The client signs it with the user's rotation key and submits it to PLC.
   `finalize` reads PLC and, only once the update is there, activates the shares and
   updates `custody_mode`; pending shares that never reach PLC are discarded after a day.

   Both calls are **idempotent**: if PLC already shows the result, `finalize` completes the
   database step. Because every direction towards the PDS needs the user's rotation key,
   a stolen password can never hand the identity to the PDS (or to whoever took the
   password). Owner signatures made before a change stay valid: they were made with the
   person's key at the time.

6. **Logging in is separate from holding keys, in every mode.** Restrictions and password
   reset:
   - The vault endpoints (`requestShareRelease`, `exportRecoveryKey`, `registerEscrow`)
     refuse with `SelfCustodyAccount` for `self`. In `assisted` they work on the PDS's key,
     which can only act subject to the user's 72-hour veto.
   - `pseudonym.signLink` refuses with `SelfCustodyAccount` for `assisted` and `self`
     ("sign with your owner key").
   - `account.getSecurityLevel` reports `custodyMode`.
   - **Password reset works the same in every mode:** the emailed link restores the login,
     nothing else.

     | | Kept where | A password reset gives you |
     | --- | --- | --- |
     | Password (login) | the PDS | a new password: you can sign in again |
     | Repo signing key (signs posts) | the PDS, always | its use, through the PDS, as before |
     | Rotation key (controls the DID) | the phrase (`assisted`, `self`) | nothing |
     | Owner key (person-level signatures) | the phrase or passkey | nothing |

   - Consequence: a stolen email or password lets an attacker sign in and **post** through
     the PDS, without the person's signature (decision 11), but not move the DID, change
     the mode, or sign as the person. With the phrase, the person moves the DID to another
     PDS and the attacker is cut off.
   - Pseudonyms have no password or email at all: they sign in with the phrase (or the
     passkey of decision 12), so there is nothing to reset.

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
   operations, passkey helpers, owner signing, mode changes. It is not in the `/sdk/v1.js`
   IIFE bundle, so Grvty and FlappySoccer bundles do not change.
   `@open-federation/pseudonym` uses the subpath for owner signing.

10. **Recovery.**
    - `custodial`: as today (the PDS rebuilds the key; identity verification for the
      vault endpoints).
    - `assisted`: the PDS recovers a lost phrase. After identity verification it signs a
      PLC update replacing the user's key with a new one from the user's new phrase. The
      update takes effect at once, but the old user key can still cancel it for 72 hours,
      so a recovery started by someone else fails if the real person still has their
      phrase. **The PDS emails the account whenever it signs a PLC update**, so the veto is
      usable, with a link to the client's "cancel this change" flow.
    - `self`: no recovery in v1. #238 tracks later options, none of which gives the PDS
      recovery power. A `self` user who wants a safety net switches to `assisted`
      (decision 5) while they still have their phrase.

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
      detectable and provable, not prevented. Option 3 (#241) adds operational
      protections: self-hosting guidance, repo monitoring and leaving with the person's
      own key (`docs/HARDENING.md`, "When the operator is the risk"). Option 2 (#240), a
      user-signed repo, is parked as a later opt-in setting.

12. **Daily unlock (#251): the phrase once per device, a passkey every day.**
    - Setting up or recovering a device: type the phrase once.
    - The device stores the phrase encrypted, with a key from a passkey through the
      WebAuthn PRF extension. The phrase is never stored in the clear; the PDS never sees
      it or the passkey secret.
    - Daily use: Face ID, Touch ID, Windows Hello or a security key unlocks the phrase on
      the device; phrase-based operations then run unchanged.
    - Client-only, no PDS changes: `rememberPhraseWithPasskey` / `unlockPhraseWithPasskey`,
      already in `@open-federation/pseudonym`, and also in `@open-federation/sdk/custody`
      for `assisted` and `self` accounts.
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
- Rotating the user's own keys without changing mode. The user can sign such PLC updates
  with their rotation key; a client helper for it is a follow-up.

## Known limits

- **Whoever has the phrase of a `self` or `assisted` account controls the DID.** In
  `assisted` the PDS can recover from a lost phrase, but not from a stolen one: the thief
  holds the higher key and can cancel the recovery.
- **The `assisted` veto only works if someone acts within 72 hours.** It depends on the
  PDS's email reaching the person and on the person still having their phrase.
- **The PDS still holds the repo key.** It can write records as the user (made detectable
  by decision 11), but it cannot make owner signatures, and outside `custodial` it cannot
  change the DID against the person's will.
- **A passkey owner key is tied to one application's domain** (its rpId), so another
  application cannot sign with it. Owner keys from the phrase work anywhere.

## Order of work

1. Policy and `custody_mode` (decisions 1, 2, 6), with `getPublicConfig` and
   `getSecurityLevel` reporting them.
2. `@open-federation/sdk/custody`: phrase keys, PLC genesis and update operations, owner
   signing in both formats, passkey unlock (decisions 3, 7, 9, 12).
3. `registerSelfCustody` for `assisted` and `self` (decision 4).
4. Mode changes in every direction (decision 5), then `assisted` recovery with the update
   email and the cancel flow (decision 10).
5. Reveal bundles v2 (decision 8), then person-signed records (decision 11).
