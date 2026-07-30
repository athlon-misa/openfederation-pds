# Integration Baseline Repair Design

## Goal

Make the private-community-read PR run the real PLC-dependent integration suite reliably and restore its green baseline without weakening its security coverage.

## Design

The PLC readiness helper will probe `/_health` first and retain `/health` as a compatibility fallback. CI already starts and verifies the local PLC; therefore, a PLC-dependent test must throw in CI when no directory is reachable, rather than return early and become a false pass.

`members_unique` is a denormalized membership projection. Its schema and migration history must include the `handle` column that `listMembers` reads. The projection write path will persist the member-record handle, and the new migration will backfill existing projection rows from member records with the member DID as a safe fallback.

Read guards intentionally conceal private resources with `NotFound` or `RepoNotFound`. Each affected XRPC lexicon must declare that error and increment its revision, allowing the runtime contract checker to emit the intended 404 response rather than a 500.

The integration suite uses one shared Postgres database, so Vitest must not run test files concurrently. The configuration will disable file-level parallelism while keeping tests within each file sequential.

## Validation

Targeted tests will cover PLC unavailability in CI, projection handle persistence, and private-resource 404 contracts. The full API suite, lexicon validation, generated-contract check, and production build must pass before merge.
