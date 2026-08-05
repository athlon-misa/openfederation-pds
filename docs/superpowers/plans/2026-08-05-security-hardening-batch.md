# Security Hardening Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve governance vote races, dashboard session persistence after logout, and unsafe/unbounded federation peer fetching.

**Architecture:** The three workstreams are independent. Governance uses a session-scoped PostgreSQL advisory lock so repository writes on other pooled connections remain serialized; dashboard logout revokes its refresh session before local-state cleanup; both federation reads use one guarded, byte-limited peer-fetch path.

**Tech Stack:** TypeScript, PostgreSQL, Express XRPC, Next.js/Zustand, Vitest, Supertest.

## Global Constraints

- Preserve existing XRPC and SDK API shapes; do not change schema or lexicons.
- Keep AT Protocol repository writes and existing audit events.
- Use Node 22 for verification; test APIs against the dedicated test DB and a temporary PLC.
- Defer crash-atomic proposal resolution to GitHub issue #188.

---

## File Structure

- `src/db/client.ts` — session-scoped advisory-lock helper.
- `src/api/net.openfederation.community.voteOnProposal.ts` — serialized proposal lifecycle.
- `tests/api/net.openfederation.community.governance.test.ts` — concurrent voting regression.
- `web-interface/src/lib/api/auth.ts` — session-revocation client.
- `web-interface/src/store/auth-store.ts` — awaited logout lifecycle.
- `src/federation/peer-cache.ts` — single guarded/bounded peer fetch seam.
- `tests/unit/peer-cache.test.ts` — redirect and resource-bound peer fetch coverage.

### Task 1: Serialize proposal votes (#100)

**Files:**
- Modify: `src/db/client.ts`, `src/api/net.openfederation.community.voteOnProposal.ts`
- Modify: `tests/api/net.openfederation.community.governance.test.ts`

**Interfaces:**
- Produces `withAdvisoryLock<T>(key: string, operation: () => Promise<T>): Promise<T>`.
- Uses key `community-proposal:${communityDid}:${proposalRkey}`.

- [ ] **Step 1: Write the failing concurrency regression**

```ts
const [forVote, againstVote] = await Promise.all([
  xrpcAuthPost('net.openfederation.community.voteOnProposal', forUser.accessJwt, inputFor),
  xrpcAuthPost('net.openfederation.community.voteOnProposal', againstUser.accessJwt, inputAgainst),
]);
const proposal = await getProposal(communityDid, proposalRkey);
expect(proposal.status).not.toBe('open');
expect(proposal.status === 'rejected').toBe(true);
expect(await getTargetRecord(communityDid, target)).toBeNull();
```

- [ ] **Step 2: Run RED**

Run: `TEST_DB_NAME=openfederation_pds_test npx vitest run tests/api/net.openfederation.community.governance.test.ts`

Expected: the original stale-read implementation can persist rejection after another request applies the target mutation.

- [ ] **Step 3: Add a session-scoped advisory-lock helper**

```ts
export async function withAdvisoryLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    return await operation();
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => undefined);
    client.release();
  }
}
```

- [ ] **Step 4: Wrap the read-to-target-mutation lifecycle**

```ts
return withAdvisoryLock(`community-proposal:${communityDid}:${proposalRkey}`, async () => {
  // Move the existing proposal lookup, status/duplicate checks, vote calculation,
  // terminal proposal write, optional target mutation, and audit events here.
});
```

- [ ] **Step 5: Run GREEN and commit**

Run: `TEST_DB_NAME=openfederation_pds_test npx vitest run tests/api/net.openfederation.community.governance.test.ts`

```bash
git add src/db/client.ts src/api/net.openfederation.community.voteOnProposal.ts tests/api/net.openfederation.community.governance.test.ts
git commit -m "fix: serialize governance proposal votes"
```

### Task 2: Revoke dashboard sessions on logout (#102)

**Files:**
- Modify: `web-interface/src/lib/api/auth.ts`, `web-interface/src/store/auth-store.ts`
- Modify: `web-interface/src/app/(dashboard)/settings/page.tsx`, `web-interface/src/components/shell/app-sidebar.tsx`
- Test: `tests/api/com.atproto.server.createSession.test.ts`

**Interfaces:**
- Produces `deleteSession(refreshJwt: string): Promise<ApiResult<{ success: boolean }>>`.
- Changes `logout(): Promise<void>`; every caller awaits it.

- [ ] **Step 1: Write the failing server-revocation regression**

```ts
const logout = await xrpcAuthPost('com.atproto.server.deleteSession', accessJwt, { refreshJwt });
expect(logout.status).toBe(200);
const replay = await xrpcPost('com.atproto.server.refreshSession', { refreshJwt });
expect(replay.status).toBe(401);
```

- [ ] **Step 2: Run RED**

Run: `TEST_DB_NAME=openfederation_pds_test npx vitest run tests/api/com.atproto.server.createSession.test.ts`

Expected: FAIL only if the endpoint does not revoke a copied refresh token; this
documents the server invariant that the dashboard client will invoke.

- [ ] **Step 3: Add the API helper and fail-open UI cleanup**

```ts
export async function deleteSession(refreshJwt: string) {
  return xrpc<{ success: boolean }>('com.atproto.server.deleteSession', {
    method: 'POST', body: { refreshJwt },
  });
}

logout: async () => {
  const refreshJwt = get().refreshToken;
  try { if (refreshJwt) await deleteSession(refreshJwt); }
  finally { set(loggedOutState); }
}
```

Change `handleChangePassword` and `handleLogout` to `await logout()` before
their existing router navigation, and change the store interface to
`logout: () => Promise<void>`.

- [ ] **Step 4: Run GREEN and commit**

Run: `TEST_DB_NAME=openfederation_pds_test npx vitest run tests/api/com.atproto.server.createSession.test.ts && npm --prefix web-interface run lint`

```bash
git add web-interface/src/lib/api/auth.ts web-interface/src/store/auth-store.ts web-interface/src/app/'(dashboard)'/settings/page.tsx web-interface/src/components/shell/app-sidebar.tsx tests/api/com.atproto.server.createSession.test.ts
git commit -m "fix: revoke dashboard session on logout"
```

### Task 3: Guard and bound peer fetching (#127, #130)

**Files:**
- Modify: `src/federation/peer-cache.ts`
- Create: `tests/unit/peer-cache.test.ts`

**Interfaces:**
- Produces `fetchPeerJson(url: string, signal: AbortSignal): Promise<unknown | null>`.
- Uses `assertPublicHttpsUrl`, `readLimitedText`, `redirect: 'error'`, `MAX_PEER_RESPONSE_BYTES = 256 * 1024`, `MAX_COMMUNITIES_PER_PEER = 100`, and `MAX_CACHED_COMMUNITIES = 500`.

- [ ] **Step 1: Write failing peer-fetch tests**

```ts
expect(await getCachedPeerInfo()).toEqual([{ healthy: false, serviceUrl: peer }]);
expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: 'error' }));
await expect(getCachedPeerCommunities()).resolves.toMatchObject({ communities: [] });
```

Mock a redirect response, a streamed body exceeding 256 KiB, and 101 valid
community records; assert no unsafe result enters the returned cache.

- [ ] **Step 2: Run RED**

Run: `TEST_DB_NAME=openfederation_pds_test npx vitest run tests/unit/peer-cache.test.ts`

Expected: FAIL because peer-cache uses default fetch redirects and `response.json()`.

- [ ] **Step 3: Implement the shared guarded fetch**

```ts
const safeUrl = await assertPublicHttpsUrl(url);
const response = await fetch(safeUrl, { signal, redirect: 'error' });
if (!response.ok) return null;
return JSON.parse(await readLimitedText(response, MAX_PEER_RESPONSE_BYTES));
```

Apply it to both peer-info and community fetches; slice each valid community
array to 100 and stop aggregate collection at 500 before caching.

- [ ] **Step 4: Run GREEN and commit**

Run: `TEST_DB_NAME=openfederation_pds_test npx vitest run tests/unit/peer-cache.test.ts`

```bash
git add src/federation/peer-cache.ts tests/unit/peer-cache.test.ts
git commit -m "fix: bound and guard federation peer fetches"
```

### Task 4: Batch verification and issue handling

- [ ] **Step 1: Run focused suites with a temporary PLC**

Run: `TEST_DB_NAME=openfederation_pds_test npx vitest run tests/api/net.openfederation.community.governance.test.ts tests/unit/peer-cache.test.ts`

- [ ] **Step 2: Build and run security suite**

Run: `KEY_ENCRYPTION_SECRET=test-key-encryption-secret-at-least-32-chars fnm exec --using 22.22.0 -- npm test && fnm exec --using 22.22.0 -- npm run build`

- [ ] **Step 3: Check the final patch and close only proven-fixed issues**

Run: `git diff --check main...HEAD`

Close #100, #102, #127, and #130 only after their respective regression tests pass and review confirms each acceptance criterion.
