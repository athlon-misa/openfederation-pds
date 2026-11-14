---
"@open-federation/pseudonym": minor
---

Pen-name follow-ups (#412):

- **A generic in-person proof context, named in the link.** `challengeForWord(word, context?)` defaults to the new `IN_PERSON_CONTEXT` (`'OpenFederation in-person proof'`) instead of requiring a context. `presenceLinkFragment` takes an optional `context` and writes it as `c=` (one line, at most 200 characters); `parseVerifyLink` returns it, and `verifyLink` checks a presence link in the context it names, so a link whose `c=` was changed is INVALID. A link without `c=`, as every link made before this version, is checked in `presenceContext`, which is now optional and defaults to the new `STAGE_PRESENCE_CONTEXT` (`'OpenNewsrooms stage challenge'`), so existing links keep verifying. The presence verdict now says which context it was checked in (`context`). Pass the context you signed with to `presenceLinkFragment`: a link that names none is read in the stage context.
- **Moving into a PDS that asks for one of its own creation tokens** (`migration.pseudonyms: 'token'`): `moveAccount` and `openAccountForMove` take an optional `creationToken`, sent to `com.atproto.server.createAccount` as `token`. A refused token fails the `open` step, before anything changed.
- **Publishing a reveal across servers:** `publishReveal` takes an optional `pseudonymPdsUrl` for a pseudonym that lives on another PDS than its owner (`pdsUrl`); each half is written at its own PDS with its own token. `revealLinkRecord(bundle)` returns the record it writes.
