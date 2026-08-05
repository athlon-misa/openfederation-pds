# SDD ledger — plan: docs/superpowers/plans/2026-08-05-security-hardening-batch.md

## Task 1 — #100: serialize governance voting

- Completed in 3 implementation rounds: proposal-scoped advisory locking, a dedicated lock pool to prevent connection starvation, and lock-pool error handling.
- Verified by the governance API suite and combined affected-suite run.

## Task 2 — #102: revoke dashboard sessions on logout

- Completed in 1 implementation round: the dashboard now calls `com.atproto.server.deleteSession` before clearing local credentials, including refresh-failure logout.
- Verified by the createSession API regression test and dashboard TypeScript check.

## Task 3 — #127 and #130: harden peer fetches

- Completed in 1 implementation round: peer metadata fetches reject unsafe URLs, disallow redirects, enforce a 256 KiB body limit, and cap the cache at 100 entries per peer / 500 total.
- Verified by peer-cache unit tests and combined affected-suite run.

## Combined verification

- `KEY_ENCRYPTION_SECRET=… fnm exec --using 22.22.0 -- npm test` — 111 passed.
- `KEY_ENCRYPTION_SECRET=… fnm exec --using 22.22.0 -- npm run build` — passed.
- `fnm exec --using 22.22.0 -- npx --prefix web-interface tsc --noEmit` — passed.
- Combined governance, session, and peer-cache Vitest suites against the local test database and temporary PLC — 32 passed.
