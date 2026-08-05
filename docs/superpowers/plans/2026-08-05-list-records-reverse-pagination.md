# `listRecords` Reverse Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return stable, cursor-correct global order from `com.atproto.repo.listRecords` for both forward and reverse pagination.

**Architecture:** `RepoEngine.listRecords` owns record ordering and cursor comparison because it owns the `records_index` query. The XRPC handler parses the public `reverse` query parameter and passes it through unchanged; it does not reorder an already-paginated page. The returned cursor is exclusive and is the rkey of the final record actually returned.

**Tech Stack:** TypeScript, Express XRPC handlers, PostgreSQL (`records_index`), Vitest, Supertest.

## Global Constraints

- Preserve the existing public XRPC request and response shape.
- Forward traversal uses `rkey > cursor` with ascending ordering.
- Reverse traversal uses `rkey < cursor` with descending ordering.
- Fetch `limit + 1` rows and omit the cursor when no additional row exists.
- Do not change schema, lexicons, or SDK code.

---

## File Structure

- `src/repo/repo-engine.ts` — repository-index query and exclusive cursor semantics.
- `src/api/com.atproto.repo.listRecords.ts` — passes the parsed direction to `RepoEngine`; no response-array reversal.
- `tests/api/com.atproto.repo.listRecords.pagination.test.ts` — API-level regression coverage using explicit, lexically ordered rkeys.

### Task 1: Establish the reverse-pagination regression

**Files:**
- Create: `tests/api/com.atproto.repo.listRecords.pagination.test.ts`

**Interfaces:**
- Consumes: `xrpcAuthPost`, `xrpcGet`, `createTestUser`, and `uniqueHandle` from `tests/api/helpers.ts`.
- Produces: failing regression coverage demonstrating globally ordered, exclusive cursor pagination at the public XRPC interface.

- [ ] **Step 1: Write the failing reverse-pagination test**

```ts
it('paginates reverse pages in one descending global rkey order', async () => {
  const user = await createTestUser(uniqueHandle('list-page'));
  const collection = 'com.example.note';
  const rkeys = ['0004', '0003', '0002', '0001'];

  for (const rkey of rkeys) {
    const created = await xrpcAuthPost('com.atproto.repo.createRecord', user.accessJwt, {
      repo: user.did,
      collection,
      rkey,
      record: { text: rkey, createdAt: new Date().toISOString() },
    });
    expect(created.status).toBe(200);
  }

  const first = await xrpcGet('com.atproto.repo.listRecords', {
    repo: user.did, collection, limit: '2', reverse: 'true',
  });
  const second = await xrpcGet('com.atproto.repo.listRecords', {
    repo: user.did, collection, limit: '2', reverse: 'true', cursor: first.body.cursor,
  });

  expect(first.status).toBe(200);
  expect(first.body.records.map((record: { uri: string }) => record.uri.split('/').at(-1))).toEqual(['0004', '0003']);
  expect(second.body.records.map((record: { uri: string }) => record.uri.split('/').at(-1))).toEqual(['0002', '0001']);
  expect(second.body.cursor).toBeUndefined();
});
```

- [ ] **Step 2: Add the forward control test in the same file**

```ts
it('paginates forward pages in one ascending global rkey order', async () => {
  const user = await createTestUser(uniqueHandle('list-page'));
  const collection = 'com.example.note';
  for (const rkey of ['0004', '0003', '0002', '0001']) {
    const created = await xrpcAuthPost('com.atproto.repo.createRecord', user.accessJwt, {
      repo: user.did,
      collection,
      rkey,
      record: { text: rkey, createdAt: new Date().toISOString() },
    });
    expect(created.status).toBe(200);
  }

  const first = await xrpcGet('com.atproto.repo.listRecords', {
    repo: user.did, collection, limit: '2',
  });
  const second = await xrpcGet('com.atproto.repo.listRecords', {
    repo: user.did, collection, limit: '2', cursor: first.body.cursor,
  });

  expect(first.status).toBe(200);
  expect(first.body.records.map((record: { uri: string }) => record.uri.split('/').at(-1))).toEqual(['0001', '0002']);
  expect(second.body.records.map((record: { uri: string }) => record.uri.split('/').at(-1))).toEqual(['0003', '0004']);
  expect(second.body.cursor).toBeUndefined();
});
```

- [ ] **Step 3: Run the targeted test to verify RED**

Run: `TEST_DB_NAME=openfederation_pds_test npx vitest run tests/api/com.atproto.repo.listRecords.pagination.test.ts`

Expected: the reverse test fails because page one is `['0002', '0001']` (the handler reverses an ascending page), rather than `['0004', '0003']`.

- [ ] **Step 4: Commit the regression tests**

```bash
git add tests/api/com.atproto.repo.listRecords.pagination.test.ts
git commit -m "test: cover reverse record pagination"
```

### Task 2: Put pagination direction in the Repository read module

**Files:**
- Modify: `src/repo/repo-engine.ts:151-182`
- Modify: `src/api/com.atproto.repo.listRecords.ts:17-51`
- Test: `tests/api/com.atproto.repo.listRecords.pagination.test.ts`

**Interfaces:**
- Consumes: `collection: string`, `limit: number`, optional `cursor: string`, and optional `reverse: boolean`.
- Produces: `RepoEngine.listRecords(collection, limit, cursor, reverse)` returning rows in requested order plus the final returned rkey as an exclusive cursor only when another row exists.

- [ ] **Step 1: Change the repository method signature and SQL selection**

```ts
async listRecords(
  collection: string,
  limit = 50,
  cursor?: string,
  reverse = false,
): Promise<{ records: Array<{ rkey: string; record: Record<string, unknown>; cid: string }>; cursor?: string }> {
  // Use cursor comparison '<' and `ORDER BY rkey DESC` when reverse is true.
  // Otherwise retain '>' and ascending ordering. Keep LIMIT limit + 1.
}
```

- [ ] **Step 2: Pass `reverse` into the engine and remove handler reversal**

```ts
const result = await engine.listRecords(collection, limit, cursor, reverse);

const records = result.records.map(r => ({
  uri: `at://${repo}/${collection}/${r.rkey}`,
  cid: r.cid,
  value: r.record,
}));
```

- [ ] **Step 3: Run the targeted test to verify GREEN**

Run: `TEST_DB_NAME=openfederation_pds_test npx vitest run tests/api/com.atproto.repo.listRecords.pagination.test.ts`

Expected: PASS; forward pages are `0001,0002` then `0003,0004`, reverse pages are `0004,0003` then `0002,0001`, and the final page has no cursor.

- [ ] **Step 4: Run affected API coverage**

Run: `TEST_DB_NAME=openfederation_pds_test npx vitest run tests/api/com.atproto.repo.listRecords.pagination.test.ts tests/api/com.atproto.repo.deleteRecord.security.test.ts tests/api/net.openfederation.forum.privateVisibility.test.ts`

Expected: PASS with no failures.

- [ ] **Step 5: Commit the implementation**

```bash
git add src/repo/repo-engine.ts src/api/com.atproto.repo.listRecords.ts tests/api/com.atproto.repo.listRecords.pagination.test.ts
git commit -m "fix: paginate reverse record listings correctly"
```

### Task 3: Final verification

**Files:**
- Verify only: `src/repo/repo-engine.ts`, `src/api/com.atproto.repo.listRecords.ts`, `tests/api/com.atproto.repo.listRecords.pagination.test.ts`

**Interfaces:**
- Consumes: the completed Repository read module and public XRPC endpoint.
- Produces: evidence that the intended behavior and repository checks are clean.

- [ ] **Step 1: Type-check and build**

Run: `npm run build`

Expected: exit code 0.

- [ ] **Step 2: Check the final patch**

Run: `git diff --check HEAD~2..HEAD`

Expected: no whitespace errors.

- [ ] **Step 3: Inspect repository status**

Run: `git status --short`

Expected: only pre-existing unrelated untracked files, if any; all pagination changes are committed.
