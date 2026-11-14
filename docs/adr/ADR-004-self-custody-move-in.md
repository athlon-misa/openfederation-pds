# ADR-004: Self-custody accounts moving in without the old PDS (#382)

**Status:** accepted · **Decided:** 2026-11-15 · **Issues:** #382 (follows #241 / #379; builds on #261–#266)

An `assisted` or `self` account ([ADR-003](ADR-003-custody-modes.md)) holds the top rotation
key of its DID. With `leavePds` (`@open-federation/sdk/custody`) the person points the DID at
another PDS without the old one, and the old operator is cut off. Until this ADR no
OpenFederation PDS would then take the account in on the person's word alone:

- `com.atproto.server.createAccount` accepted a rotation-key proof only from pseudonyms. A user
  account needed a service-auth token from the old PDS (`getServiceAuth`), which a hostile or
  unreachable operator does not give.
- `com.atproto.repo.importRepo` accepted only a CAR signed by the DID's *current* `atproto` key
  (the #265 rollback guard). After `leavePds` the current key is the new PDS's, so the
  repository the old PDS signed was refused.

Pseudonyms could already move this way (`moveAccount` in `@open-federation/pseudonym`).

## Threat model

| Who | Wants to | Holds |
| --- | --- | --- |
| **A hostile old PDS** | Keep the person from leaving, keep writing as them, or follow them to the new PDS and keep control there | The old `atproto` key, every repository it ever signed, the person's password hash and email; in `assisted` a lower rotation key |
| **Someone with a stolen phrase** | Take the identity | The person's top rotation key (and owner key) |
| **Anyone replaying an old repository** | Erase records (votes, objections, posts) by importing an older signed export, or plant a repository signed by a key the DID once named | Old CARs, which are public; possibly an old PDS's key |
| **Someone with the password only** | Move the account | The login, nothing else (ADR-003, decision 6) |

## Decisions

1. **Proof of control: the DID's top rotation key.** `createAccount` accepts, in place of the
   old PDS's service auth, a JWT in the shape of service auth (`iss` = the DID, `aud` = this
   PDS's service DID, `lxm` = `com.atproto.server.createAccount`, at most 300 seconds, one use
   through the replay cache) signed by **`rotationKeys[0]` of the DID's current PLC state**,
   and by no other key. It applies when:
   - the DID is not shaped like a pseudonym (those keep their own path);
   - the current state publishes `openfederation_owner`, i.e. it is an ADR-003 `assisted` or
     `self` DID. A DID without it is refused with `IncompatibleDidDoc`, as before;
   - the request did not arrive with valid service auth (that is the custodial path of #266,
     unchanged).

   The account **arrives as `self`**: this PDS holds none of its keys, makes no rotation key for
   it and stores no vault shares. It is refused with `CustodyModeNotAllowed` when `self` is not
   in `IDENTITY_CUSTODY_ALLOWED`. Email and password are required, because login stays
   password-based (ADR-003, decision 6); the password is new, the old PDS's is never involved.
   The person can switch to `assisted` later with the normal custody change (ADR-003,
   decision 5). The account starts deactivated with `migrating_in`, like every arrival.

   Only the top key, not any listed rotation key: in `assisted` the old PDS holds the second
   key, and a recovery key (ADR-003, decision 13) ranks below the phrase key too. Neither may
   open the account somewhere else.

2. **Importing a repository signed by the key before the move.** `importRepo` accepts the DID's
   current `atproto` key as before, and additionally, **only for a user account that arrived
   through decision 1 and has not been activated yet** (`custody_mode = 'self'`, `auth_type =
   'local'`, `migrating_in`, deactivated), the `atproto` key of the PLC operation immediately
   before the one that points the DID here. All of the following must hold in the DID's active
   PLC log, read uncached from the directory:
   - the last operation **P** names this PDS (`atproto_pds` endpoint = this server's service
     URL), and the one before it, **Q**, does not: P is the operation that moved the DID here
     and nothing has happened since;
   - P's `prev` is Q's CID;
   - Q publishes `openfederation_owner`, so it was the person's `assisted` or `self` state;
   - **P is signed by Q's first rotation key**, verified here (not taken on PLC's word): the
     person's own key, never a PDS's backup key, which ADR-003 always lists below it;
   - P keeps that key first, so the person who signed the move is the one who proved control
     in decision 1.

   The key accepted is then Q's `atproto` key: the old PDS's (or the person's device key, with
   device signing). **Nothing older**: a CAR signed by a key two operations back is refused
   (`InvalidSignature`), as is any repository once the account has been activated. Every other
   account keeps exactly the #265 rule (current key only, and no older revision over a
   repository with history, `RepoRollback`).

3. **Policy.** Allowed under `MIGRATION_ACCOUNTS=open` and `invite` (an invite code is still
   required under `invite`, `InvalidInviteCode` without one), refused under `closed`
   (`MigrationNotAllowed`). Read with `runtimeSettings()` at request time. The refusal happens
   before anything is stored. Audited as `account.moveIn` with `{ did, handle, method:
   'rotation-key' }`; activation is audited as for any move (`account.activate`, `migrated:
   true`).

4. **Blobs come from the person's backup.** The old PDS may be gone. The SDK's
   `downloadBackup` saves the repository and every blob while the old PDS still answers;
   `copyRepo` uploads blobs from that backup (`backupBlobs`) when no `fromUrl` is given.
   `moveIn` runs the whole flow: open the account (rotation-key proof), import, blobs, check,
   `leavePds` if the DID does not point here yet, activate. The guide tells people to download
   a backup **before** `leavePds`, and to keep downloading one regularly (a `RepoWatcher`
   check returns the CAR too).

5. **Either order works.** Opening the account and importing before `leavePds` needs nothing
   new from decision 2 (the current key is still the old PDS's), and refusals happen before the
   DID changes, so it is the default of `moveIn`. `leavePds` first is the emergency order: the
   operator is cut off at once and the repository follows. In that order, reserve the signing
   key at the new PDS (`reserveSigningKey`) before `leavePds` and import before any other PLC
   update (adding a recovery key, say): a later operation ends the window of decision 2.

## What this protects, per threat

- **A hostile old PDS** cannot stop the move: nothing on the path asks it for anything. It
  cannot open the account at the new PDS through decision 1 (it never holds the top key; in
  `assisted` its key is below the person's). It can open one through service auth (#266) while
  it still holds the DID's `atproto` key, but only before `leavePds`, and only at a PDS it
  guesses; such a copy can never be activated, because activation needs the DID to name a key
  of the new PDS, which only a rotation key can do for a `self` DID. Its repository is accepted
  only if the person's own key signed the move away from it; if the PDS signed a move with its
  backup key (`assisted`), its repository is refused, so a backup key cannot carry a replayed
  repository along.
- **A replayed old repository** has a narrow window. Only the key named immediately before the
  move counts, only until the first activation, only after a move signed by the person's own
  key, and only for a session opened with the person's rotation key and password. A key from an
  earlier home (two operations back) is refused. Once active, the account is under the #265
  rules like every other.
- **A stolen phrase** wins, as everywhere in ADR-003: the thief can `leavePds` to a PDS of their
  choice and open the account there. This ADR adds nothing a thief could not already do with
  PLC (pointing the DID elsewhere); the 72-hour veto of a higher key does not exist for the top
  key. A recovery key cannot be used for decision 1.
- **The password alone** moves nothing: decision 1 needs the rotation key.

## What is not protected

- **The person chooses which revision to import.** Decision 2 checks the key, not the revision:
  any repository the old PDS signed, including an old one, can be imported into a new arrival.
  That is the person's own data; there is no history at the new PDS to roll back, and imported
  votes and objections are indexed only under `communityGovernanceRecordsToKeep` and the
  membership rules of `src/repo/import.ts`.
- **Records the old PDS forged** before the move are in the repository it signed. Decision 2
  does not tell them apart; `ownerSig` (ADR-003, decision 11) and `RepoWatcher` do.
- **A copy pre-opened by the old PDS** (service auth, guessed destination) blocks decision 1
  with `AlreadyExists` until an administrator of the new PDS removes it, or the person moves
  elsewhere. It cannot be activated.
- **Blobs not in the backup** are lost if the old PDS is gone; `checkAccountStatus` reports
  `expectedBlobs` and `importedBlobs`, and `moveIn` refuses to finish without all of them
  unless the caller says otherwise (`allowMissingBlobs`).
- **Pseudonyms** keep their own path; decision 2 does not apply to them (their DIDs publish no
  `openfederation_owner`). A pseudonym whose old PDS is gone imports before pointing the DID.
- **A DID that still lists the old PDS's rotation key** (`leavePds` with
  `keepOtherRotationKeys`) still arrives as `self` here. The old PDS keeps its lower key and its
  72-hour-vetoable power over the DID; the default `leavePds` removes it.

## Out of scope

- Arriving as `assisted` directly (the PDS would need a reserved rotation key in the DID first).
  Switch after arrival.
- Device signing on arrival: the account arrives with this PDS's `atproto` key and can turn
  device signing on afterwards (ADR-003, decision 14).
