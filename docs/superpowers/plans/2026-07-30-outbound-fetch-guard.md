# Outbound Fetch Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent untrusted DID and PDS metadata from causing outbound PDS requests to private or reserved destinations.

**Architecture:** A single security module validates parsed HTTPS URLs and resolved addresses before federation code requests them. Service-auth rejects untrusted did:web issuers because its third-party resolver cannot accept a guarded fetch implementation.

**Tech Stack:** TypeScript, Node DNS, Vitest, PostgreSQL-backed integration tests.

## Global Constraints

- Keep `did:plc` service-auth and configured PLC resolution AT Protocol-compatible.
- Reject redirects and do not disclose internal destination details.
- Add tests before each behavioral production change.

---

### Task 1: Guarded outbound URL policy

**Files:**
- Create: `src/security/outbound-fetch.ts`
- Test: `tests/unit/outbound-fetch.test.ts`

**Interfaces:**
- Produces: `assertPublicHttpsUrl(raw: string): Promise<URL>`.

- [ ] **Step 1: Write failing unit tests**

```ts
await expect(assertPublicHttpsUrl('https://127.0.0.1:8443/a')).rejects.toThrow();
await expect(assertPublicHttpsUrl('http://public.example/a')).rejects.toThrow();
```

- [ ] **Step 2: Run the unit test and verify failure**

Run: `npx vitest run tests/unit/outbound-fetch.test.ts`

- [ ] **Step 3: Implement parsed scheme/authority and DNS-address validation**

```ts
export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password) throw new OutboundFetchError();
  // reject literal and DNS-resolved private/reserved addresses
  return url;
}
```

- [ ] **Step 4: Run the unit test and verify pass**

Run: `npx vitest run tests/unit/outbound-fetch.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/security/outbound-fetch.ts tests/unit/outbound-fetch.test.ts
git commit -m "fix: guard outbound HTTPS destinations"
```

### Task 2: Apply the guard to federation lookup and remote records

**Files:**
- Modify: `src/federation/remote-verify.ts`
- Test: `tests/api/partner-verification.test.ts`

**Interfaces:**
- Consumes: `assertPublicHttpsUrl(raw: string): Promise<URL>`.

- [ ] **Step 1: Write failing regression tests**

```ts
expect(await resolveDidToPds('did:web:127.0.0.1:8443')).toBeNull();
expect(await fetchRemoteRecord('https://127.0.0.1:8443', did, collection, rkey)).toBeNull();
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npx vitest run tests/api/partner-verification.test.ts`

- [ ] **Step 3: Route did:web and PDS endpoint fetches through guarded fetch**

```ts
const url = await assertPublicHttpsUrl(rawUrl);
const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
```

- [ ] **Step 4: Run the test and verify pass**

Run: `npx vitest run tests/api/partner-verification.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/federation/remote-verify.ts tests/api/partner-verification.test.ts
git commit -m "fix: guard federation remote destinations"
```

### Task 3: Block untrusted did:web service-auth issuers

**Files:**
- Modify: `src/auth/service-auth.ts`
- Test: `tests/api/service-auth.test.ts`

**Interfaces:**
- Consumes: `isSafeServiceAuthIssuer(did: string): boolean`.

- [ ] **Step 1: Write failing regression test**

```ts
await expect(verifyServiceAuthJwt(forgedDidWebToken)).rejects.toMatchObject({ code: 'IssuerResolutionFailed' });
expect(resolveSigningKey).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the test and verify failure**

Run: `npx vitest run tests/api/service-auth.test.ts`

- [ ] **Step 3: Reject did:web before resolver invocation**

```ts
if (iss.startsWith('did:web:')) throw new ServiceAuthError('IssuerResolutionFailed', 'Unsupported service-auth issuer');
```

- [ ] **Step 4: Run the test and verify pass**

Run: `npx vitest run tests/api/service-auth.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/auth/service-auth.ts tests/api/service-auth.test.ts
git commit -m "fix: reject untrusted did web service-auth issuers"
```

### Task 4: Validate the slice

**Files:**
- Modify only files produced by Tasks 1-3 as required by verification.

- [ ] **Step 1: Run focused tests**

Run: `npx vitest run tests/unit/outbound-fetch.test.ts tests/api/service-auth.test.ts tests/api/partner-verification.test.ts`

- [ ] **Step 2: Run build and complete API/unit CI**

Run: `npm run build && npm run test:api`

- [ ] **Step 3: Commit any verification corrections**

```bash
git add <verified files>
git commit -m "test: cover outbound fetch guard"
```
