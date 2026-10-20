# Night Desk: the stage demo

A five-minute live demo of OpenFederation pseudonyms, styled as Open Newsrooms. Elena Petrova, a reporter, creates an anonymous name, "Night Desk", publishes as it, and later proves in front of the audience that Night Desk is her.

Everything runs on the presenter's laptop, with no internet:

| Part | Port | Notes |
|---|---|---|
| PLC directory | 2683 | In memory, so every reset starts empty |
| PDS | 8091 | Its own database, `openfederation_pds_demo`, rebuilt on every reset |
| Stage app | 4747 | Bound to localhost |

The browser plays Elena's laptop. It runs the real `@open-federation/pseudonym` code, so Night Desk's twelve words and key exist only in the page. The demo server (`run.ts`) seeds Elena's account, reads the PDS database for the "What the server knows" screen, and acts as the independent verifier for the in-person proof.

## Run it

Postgres must be running (the same one as `npm run dev`, configured by `.env`).

```bash
npm run demo
```

Open http://localhost:4747 when the terminal says `Ready`. Use the arrow keys or the step bar to move between screens. "Reset demo" (bottom right) rebuilds the database and directory and reseeds Elena, in about ten seconds.

Logs from the PDS and PLC are in `demo/stage/.logs/`.

## The screens

1. **Start**: Elena Petrova, investigative reporter.
2. **Tokens**: her app collects this month's 20 blind creation tokens.
3. **Create**: twelve words and a key are made in the browser; Night Desk is registered with PLC and opened on the PDS by spending one token, with no login.
4. **Server**: the PDS's own `users` rows for both accounts, and a row-by-row search of every table for anything naming both. It finds nothing.
5. **Publish**: Night Desk signs in with the twelve words alone and publishes an authorship claim (a fingerprint of the article).
6. **Prove**: someone in the audience calls out a word. Night Desk's words sign it, and the verifier checks the signature against Night Desk's key in PLC: VALID. "A stranger tries" signs with new random words: INVALID.
7. **Next**: what was shown, and what comes next.

The audience's word becomes the 64-hex presence challenge as `sha256("OpenNewsrooms stage challenge\n" + word)`, computed separately by the page and the verifier.

## Rehearsal checklist

- Laptop on power, notifications off, wifi off (the demo needs none).
- `npm run demo` started at least a minute before; status in the header is green.
- Press "Reset demo" once, then go back to the start screen.
- Browser full screen; check the text is readable from the back of the room. Zoom with the browser if needed.
- Have the fallback video ready in case anything fails.

## What it does not show yet

Elena's account is custodial, so her half of a *public* reveal would be signed by a key the PDS holds. The demo therefore centres on the in-person proof, which depends on Night Desk's twelve words alone. Showing self-custody waits for identity custody modes.
