# Night Desk: the stage demo

A five-minute live demo of OpenFederation pseudonyms, styled as Open Newsrooms. Elena Petrova, a reporter, creates an anonymous name, "Night Desk", publishes as it, and later proves in front of the audience that Night Desk is her.

It runs in two modes. **Offline** (the default, and the fallback) runs everything on the presenter's laptop, with no internet. **Live** runs the same screens against two real servers and the public PLC directory (see [Live mode](#live-mode)).

Offline:

| Part | Port | Notes |
|---|---|---|
| PLC directory | 2683 | In memory, so every reset starts empty |
| PDS | 8091 | Its own database, `openfederation_pds_demo`, rebuilt on every reset |
| Second PDS, "the new home" | 8092 | Database `openfederation_pds_demo_b`; Night Desk moves here on the Move screen |
| Stage app | 4747 | Bound to localhost |

The browser plays Elena's laptop. It runs the real `@open-federation/pseudonym` code, so Night Desk's twelve words and key exist only in the page. The demo server (`run.ts`) seeds Elena's account and Marko's (the impostor) offline or signs Elena in live, shows what the server knows (offline: the PDS database; live: the public record), and acts as the independent verifier for the in-person proof and the reveal. It verifies with the same code (`verifyRevealBundle`, `checkPresence` from the pseudonym package) as the public `/verify` page the audience's phones open.

Offline, Elena is a `self` account (ADR-003), registered the way the dashboard does it: a twelve-word identity phrase made on the demo server, its rotation key the only one in her DID and its owner key named `openfederation_owner`, then `registerSelfCustody` and approval. The demo server keeps the phrase in memory for the session and hands it to the page (`/api/elena-phrase`, localhost only) when Elena signs her half of the reveal. Marko is custodial.

## Run it

Postgres must be running (the same one as `npm run dev`, configured by `.env`).

```bash
npm run demo
```

Open http://localhost:4747 when the terminal says `Ready`. Use the arrow keys or the step bar to move between screens. "Reset demo" (bottom right) rebuilds the database and directory and reseeds Elena, in about ten seconds.

Logs from the PDS and PLC are in `demo/stage/.logs/`.

## Live mode

| Part | Live | Override |
|---|---|---|
| PLC directory | plc.openfederation.net (public, permanent) | `DEMO_PLC_URL` |
| Server A, Elena's newsroom server | pds.openfederation.net | `DEMO_PDS_A_URL` |
| Server B, Night Desk's new home | pds.grvty.app | `DEMO_PDS_B_URL` |
| Stage app | localhost:4747 (passkeys need `localhost`) | `DEMO_APP_PORT` |

Nothing starts locally except the stage app, and it has no admin or database access. Everything Night Desk does is real and public: anyone can look up its DID, its PLC history (created on A, moved to B) and its repository from their own phone.

### Accounts: `demo/stage/.live.env`

Copy `demo/stage/live.env.example` to `demo/stage/.live.env` (git-ignored) and fill it in. The accounts are created once by hand on server A and approved there:

- **Elena** (`DEMO_ELENA_HANDLE`, `DEMO_ELENA_PASSWORD`, `DEMO_ELENA_DID`): kept fresh for the show. The handle may be given with or without the server's domain. For the self-custody act, create her as `self` (Settings → custody on the dashboard, or sign up with own keys) and add her twelve-word identity phrase as `DEMO_ELENA_PHRASE`: her own key signs her half of the reveal and the verifier says *signed by the person*. The phrase stays in `.live.env` and in the stage app's memory; it is never logged. A custodial Elena still works (no phrase needed): her server signs (`signLink`) and the screen says *signed by the server's key*. The mode is read from her server (`getSecurityLevel`).
- **Marko** (`DEMO_MARKO_DID`, or `DEMO_MARKO_HANDLE` resolved on A): his public DID is all "Marko claims Night Desk" needs. Optionally `DEMO_MARKO_HANDLE` and `DEMO_MARKO_PASSWORD` (custodial account) turn on the contrast: Marko reveals his own pseudonym, Late Shift, made once on A with one of his passes.
- **Rehearsal accounts** (`DEMO_REHEARSAL_1_*`, `DEMO_REHEARSAL_2_*`, …): used instead of Elena's for rehearsals.

Environment variables of the same name override the file; `DEMO_LIVE_ENV` points at another file and `DEMO_LIVE_DIR` at another folder for what the laptop keeps.

### Run it

```bash
npm run demo -- --live                 # the show (or DEMO_MODE=live npm run demo)
npm run demo -- --live --rehearsal     # rehearse with DEMO_REHEARSAL_1_* (--rehearsal=2 for account 2)
```

### Pre-flight

On start, and again on "Reset demo", `run.ts` checks with reads only, plus one sign-in:

- server A, server B and the PLC directory answer (`describeServer`, `/_health`); each server's service DID and handle domain are read from `describeServer`, never assumed;
- A's and B's `getPublicConfig` say pseudonyms are on and pseudonym moves are `open`;
- Elena (or the rehearsal account) can sign in on A, as the DID in `.live.env`, and her custody mode (`getSecurityLevel`);
- for a `self` or `assisted` Elena: `DEMO_ELENA_PHRASE` (or `DEMO_REHEARSAL_<N>_PHRASE`) holds her DID's first rotation key and its `openfederation_owner` key in the directory;
- the directory the stage app writes to, and each server's `plcDirectoryUrl`, return the same entry for Elena, and it names server A;
- Marko's DID is known; the custodial contrast is on when Marko can sign in and is custodial (optional: shown as off, never red);
- passes left this month. The server can't tell (it never sees which passes were used), so this counts the passes kept on this laptop; before the month's first collection it shows as unknown, not red.

All green: the header says `Live · pds.openfederation.net → pds.grvty.app · pre-flight green · N passes` (hover it for every check). Anything red: a banner lists the checks and says to start the offline demo instead; "Check again" reruns them.

### What differs from offline

- **Passes.** Each account collects 20 passes once a month; a second collection is refused. They are kept on this laptop in `demo/stage/.live/wallets.json` (git-ignored), so a reset or restart doesn't lose them. One pass per run.
- **Night Desk's handle.** `nightdesk` (`nightdesk-rehearsal` in a rehearsal), numbered (`nightdesk-2`, …) when an earlier run still holds it on A or B. It is checked before the genesis operation is written, since the handle goes into the public entry.
- **Server screen.** Live, there is no database to open. The screen says "Public view" and shows, side by side, Elena's and Night Desk's PLC entries (`/<did>/log/audit`) and repositories (`describeRepo`, `listRecords`), and checks that neither names the other's DID or handle. Offline keeps the database view and says so.
- **Move.** B is another origin with its own handle domain: Night Desk becomes `nightdesk.grvty.app` (B's `availableUserDomains`), and the Move screen shows B's PLC entry and B's copy of the repository.
- **Reset.** Forgets Night Desk in this browser and reruns the pre-flight. Nothing on the servers is deleted.

### Rehearsals and cleanup

Every run leaves a pseudonym DID in the public PLC and accounts on A and B. In a rehearsal (and only then) the stage app keeps Night Desk's twelve words in `demo/stage/.live/rehearsals.json` (git-ignored, readable only by you), written before the DID is registered. Afterwards:

```bash
npm run demo -- --cleanup --dry-run    # list what would be removed
npm run demo -- --cleanup
```

Marko's Late Shift is kept in the same file (created once, reused by every run), so cleanup removes it too and the next run makes a new one. For each rehearsal pseudonym not yet cleaned, it deletes its accounts on A and B with its own words (`com.atproto.server.deleteAccount` with an owner-key JWT; a deactivated copy whose DID still names that server is switched back on first), then tombstones its DID (`tombstone` from `@open-federation/pseudonym`). Accounts go first: servers check the owner key against the DID's current rotation keys, which a tombstoned DID no longer has. The words are erased from the file once the DID is gone; a failed entry is retried on the next run. Show runs keep no words, so they can't be cleaned up this way.

## The screens

1. **Start**: Elena Petrova, investigative reporter.
2. **Passes**: her app collects this month's 20 creation passes (blind tokens in the code; the screen avoids crypto vocabulary).
3. **Create**: twelve words and a key are made in the browser; Night Desk is registered with PLC and opened on the PDS with one pass, with no login.
4. **Server**: the PDS's own `users` rows for both accounts, a row-by-row search of every table for anything naming both (it finds nothing), and short notes on what a handle, a DID and a public key are.
5. **Publish**: Night Desk signs in with the twelve words alone. "Remember on this laptop" creates a passkey and stores the words encrypted under its PRF output (`rememberPhraseWithPasskey`, #251). "Sign out", then "Unlock with Touch ID" signs in again without typing anything. Night Desk then publishes an authorship claim (a fingerprint of the article).
6. **Files**: Night Desk's repository shown as folders and files, read live from the PDS (`describeRepo`, `listRecords`). Pick a file to open it. "Download a backup" saves the whole repository as one CAR file (`com.atproto.sync.getRepo`).
7. **Move**: Night Desk moves to the second PDS with `moveAccount` from `@open-federation/pseudonym`, in the standard AT Protocol order, driven only by its twelve words: the new server opens a deactivated account (`com.atproto.server.createAccount`, proved with the owner key), the repository is copied (`sync.getRepo` → `com.atproto.repo.importRepo`, verified by the new server), the new server confirms it (`checkAccountStatus`), the words sign a PLC update with the new server's recommended credentials, the account is activated there and the old server's account is deactivated. Night Desk is then signed in at the new home: Publish and Files use it from then on.
8. **Reveal**: Elena makes a reveal bundle and the verifier checks it online, as `ofc pseudonym verify --online` does: VALID, "Night Desk belongs to Elena Petrova". With a `self` Elena her own key signs her half in the page (`ownerSigner`, from her identity phrase), and the screen says *Signed by Elena herself … her server never had it* (`ownerAttestation: person`). "Marko claims Night Desk" swaps Marko's account into Elena's proof: INVALID. "Marko reveals his own pen name" (when the contrast is on) checks a custodial reveal: VALID, *Signed by the server's key* (`pds-held-key`). Live, a QR code opens the last-checked proof on the audience's phones.
9. **In person**: someone in the audience calls out a word. Night Desk's words sign it, and the verifier checks the signature against Night Desk's key in PLC: VALID. "A stranger tries" signs with new random words: INVALID. Live, a QR code lets phones check the same signature themselves.
10. **Next**: what was shown, and what comes next.

The "sealed note" on the Reveal screen is the commitment in Night Desk's genesis operation; "the opener" is the commitment salt. The audience's word on the In person screen becomes the 64-hex presence challenge as `sha256("OpenNewsrooms stage challenge\n" + word)`, computed separately by the page and the verifier.

### Audience phones: `/verify`

Live, the In person and Reveal screens show a QR code for the public verifier on the dashboard, `https://beta.openfederation.net/verify` (`DEMO_VERIFIER_URL`). The proof rides in the URL fragment (`#…`), which browsers never send to a server, so no log sees it:

- in person: `#w=<word>&d=<did without did:plc:>&s=<signature>`;
- reveal: `#r=2&p=<pseudonym>&o=<owner>&t=<issued, ms>&k=o|a&ps=<pseudonym signature>&os=<owner signature>&s=<salt>`. The genesis operation and the owner's key are left out: the phone reads both from the directory. About 340 characters, a version 12–13 QR code.

The phone checks it on its own against the PLC directory the dashboard's PDS names (`getPublicConfig.plcDirectoryUrl`, else plc.openfederation.net), with the same code as the demo server, and says VALID or INVALID, who (by handle), and for a reveal whether the person or the server's key signed. Nothing goes through the laptop. "Marko claims Night Desk" and "A stranger tries" make codes too; phones say INVALID.

Offline there is no QR code: phones can't reach the laptop's servers, and the screen says so. To try the page locally, run the dashboard with `npm run dev` in `web-interface/` and open `http://localhost:3001/verify?plc=http://localhost:2582#…` (`?plc=` works in development only), or set `DEMO_VERIFIER_URL` to that address for a live rehearsal against local servers.

Generated twelve-word phrases never contain crypto-, money- or security-sounding words (`PHRASE_AVOID_WORDS` in the pseudonym package).

## Rehearsal checklist

- Laptop on power, notifications off.
- Offline show: wifi off (the demo needs none). `npm run demo` started at least a minute before; status in the header is green. Press "Reset demo" once, then go back to the start screen.
- Live show:
  - Test the venue network: open pds.openfederation.net, pds.grvty.app and plc.openfederation.net from the laptop on the venue wifi (and a phone hotspot as backup).
  - `npm run demo -- --live`: pre-flight green on both servers, with passes left for Elena; for a `self` Elena, "Elena's own key matches her DID" green.
  - Scan a QR code (In person and Reveal) with two different phones, on the venue wifi and on mobile data: each says VALID within a few seconds, and *Signed by the person* for Elena's reveal. Check the code scans from the back of the room; zoom the browser if not.
  - Start the offline demo as a hot spare on other ports, in a second terminal: `DEMO_APP_PORT=4848 DEMO_PLC_PORT=2783 DEMO_PDS_PORT=8191 DEMO_PDS_B_PORT=8192 npm run demo`, open in a second browser window.
  - Rehearse with `--rehearsal`, never with Elena's show account; then `npm run demo -- --cleanup`.
- Browser full screen; check the text is readable from the back of the room. Zoom with the browser if needed.
- Have the fallback video ready in case anything fails.
- Open the page as `http://localhost:4747`, not `127.0.0.1`: passkeys don't work on an IP address. Use Chrome or Safari 18; without passkey PRF support the button explains it and the twelve-word login still works.
- Each rehearsal of "Remember on this laptop" adds a passkey named "Stage demo pseudonym" for `localhost` to the laptop's password manager. Reset doesn't remove them; delete old ones there (Chrome: Settings → Passwords → passkeys; macOS: Passwords app).

## What it does not show yet

- Blobs (images) are not moved yet (#264); Night Desk has none in the demo.
- OAuth is disabled on both offline demo servers because they run on `localhost`. The demo doesn't use it.
- A reveal signed with a passkey (a `webauthn` owner signature) is too long for a QR code; the demo signs with the key from Elena's phrase.
