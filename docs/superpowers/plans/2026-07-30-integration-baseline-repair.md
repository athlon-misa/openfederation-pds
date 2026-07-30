# Integration Baseline Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore reliable PLC-backed integration coverage and make the private-read branch green.

**Architecture:** Keep the real PLC readiness probe, fail closed in CI, repair the membership projection's handle column, and declare security guard error responses in their lexicons. Run file-level integration tests serially because they share one database.

**Tech Stack:** TypeScript, Vitest 4, PostgreSQL 15, AT Protocol lexicons.

## Global Constraints

- Preserve AT Protocol compatibility; extend error contracts rather than changing endpoint semantics.
- Bump every changed lexicon revision and regenerate checked-in contracts.
- Do not let missing CI infrastructure turn PLC-dependent tests into false passes.

---

### Task 1: Make PLC availability and test execution deterministic

**Files:**
- Modify: `tests/api/helpers.ts`, `tests/api/helpers.test.ts` or closest helper test
- Modify: `vitest.config.ts`

- [ ] Write a failing test proving missing PLC throws when `CI=true`.
- [ ] Run the focused test and confirm it fails for the old helper.
- [ ] Probe `/_health`, retain `/health` fallback, and throw only in CI when neither is reachable.
- [ ] Disable Vitest file parallelism.
- [ ] Run the focused test and confirm it passes.

### Task 2: Repair the member handle projection

**Files:**
- Modify: `src/db/schema.sql`, `src/repo/repo-engine.ts`, `src/api/net.openfederation.community.listMembers.ts`
- Create: `scripts/migrate-0NN-member-handle-projection.sql`
- Test: `tests/api/net.openfederation.community.member-projection.test.ts`

- [ ] Add a failing member-list assertion that needs the projected handle.
- [ ] Run the focused member projection test and confirm the missing-column failure.
- [ ] Add the base-schema column, forward migration/backfill, and write-path value.
- [ ] Run the focused member projection test and confirm it passes.

### Task 3: Declare private-read guard error contracts

**Files:**
- Modify: `src/lexicon/net.openfederation.forum.listThreads.json`
- Modify: `src/lexicon/net.openfederation.calendar.listEvents.json`
- Modify: `src/lexicon/net.openfederation.calendar.listRsvps.json`
- Modify: `src/lexicon/com.atproto.repo.listRecords.json`
- Modify: generated lexicon contracts
- Test: `tests/api/net.openfederation.forum.privateVisibility.test.ts`

- [ ] Run the private-visibility test and confirm it receives 500 before declarations.
- [ ] Add `NotFound` or `RepoNotFound` to each matching query contract and bump revisions.
- [ ] Regenerate lexicon contracts.
- [ ] Run the private-visibility test and confirm expected 404 responses.

### Task 4: Verify and merge

- [ ] Run `npm run lexicon:validate`, `npm run build`, and `npm run test:api`.
- [ ] Inspect the diff for only scoped changes.
- [ ] Commit and push the branch.
- [ ] Confirm PR #168 checks pass, then merge only if GitHub reports mergeable and all required checks are successful.
