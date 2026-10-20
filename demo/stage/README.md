# Night Desk: the stage demo

A five-minute live demo of OpenFederation pseudonyms, styled as Open Newsrooms. Elena Petrova, a reporter, creates an anonymous name, "Night Desk", publishes as it, and later proves in front of the audience that Night Desk is her.

Everything runs on the presenter's laptop, with no internet:

| Part | Port | Notes |
|---|---|---|
| PLC directory | 2683 | In memory, so every reset starts empty |
| PDS | 8091 | Its own database, `openfederation_pds_demo`, rebuilt on every reset |
| Second PDS, "the new home" | 8092 | Database `openfederation_pds_demo_b`; Night Desk moves here on the Move screen |
| Stage app | 4747 | Bound to localhost |

The browser plays Elena's laptop. It runs the real `@open-federation/pseudonym` code, so Night Desk's twelve words and key exist only in the page. The demo server (`run.ts`) seeds Elena's account and Marko's (the impostor), reads the PDS database for the "What the server knows" screen, and acts as the independent verifier for the in-person proof.

## Run it

Postgres must be running (the same one as `npm run dev`, configured by `.env`).

```bash
npm run demo
```

Open http://localhost:4747 when the terminal says `Ready`. Use the arrow keys or the step bar to move between screens. "Reset demo" (bottom right) rebuilds the database and directory and reseeds Elena, in about ten seconds.

Logs from the PDS and PLC are in `demo/stage/.logs/`.

## The screens

1. **Start**: Elena Petrova, investigative reporter.
2. **Passes**: her app collects this month's 20 creation passes (blind tokens in the code; the screen avoids crypto vocabulary).
3. **Create**: twelve words and a key are made in the browser; Night Desk is registered with PLC and opened on the PDS with one pass, with no login.
4. **Server**: the PDS's own `users` rows for both accounts, a row-by-row search of every table for anything naming both (it finds nothing), and short notes on what a handle, a DID and a public key are.
5. **Publish**: Night Desk signs in with the twelve words alone and publishes an authorship claim (a fingerprint of the article).
6. **Files**: Night Desk's repository shown as folders and files, read live from the PDS (`describeRepo`, `listRecords`). Pick a file to open it. "Download a backup" saves the whole repository as one CAR file (`com.atproto.sync.getRepo`).
7. **Move**: Night Desk moves to the second PDS. The page takes the backup, the new server loads it (`net.openfederation.admin.importRepo`, run as that server's admin), and Night Desk's twelve words sign a PLC update pointing the DID at the new server. The page then reads the files back from the new server.
8. **Reveal**: Elena makes a reveal bundle and the verifier checks it online, as `ofc pseudonym verify --online` does: VALID, "Night Desk belongs to Elena Petrova". "Marko claims Night Desk" swaps Marko's account into Elena's proof: INVALID.
9. **In person**: someone in the audience calls out a word. Night Desk's words sign it, and the verifier checks the signature against Night Desk's key in PLC: VALID. "A stranger tries" signs with new random words: INVALID.
10. **Next**: what was shown, and what comes next.

The "sealed note" on the Reveal screen is the commitment in Night Desk's genesis operation; "the opener" is the commitment salt. The audience's word on the In person screen becomes the 64-hex presence challenge as `sha256("OpenNewsrooms stage challenge\n" + word)`, computed separately by the page and the verifier.

Generated twelve-word phrases never contain crypto-, money- or security-sounding words (`PHRASE_AVOID_WORDS` in the pseudonym package).

## Rehearsal checklist

- Laptop on power, notifications off, wifi off (the demo needs none).
- `npm run demo` started at least a minute before; status in the header is green.
- Press "Reset demo" once, then go back to the start screen.
- Browser full screen; check the text is readable from the back of the room. Zoom with the browser if needed.
- Have the fallback video ready in case anything fails.

## What it does not show yet

- The new home holds Night Desk's files and the directory points to it, but it has no login account for Night Desk yet, so Night Desk can't publish from there. A real move also opens the account on the new server (AT Protocol account migration); that is not built.
- OAuth is disabled on both demo servers because they run on `localhost`. The demo doesn't use it.


Elena's account is custodial, so her half of the reveal is signed by a key the PDS holds, and the Reveal screen says so. The Night Desk half and the sealed note do not depend on the PDS. Showing self-custody waits for identity custody modes.
