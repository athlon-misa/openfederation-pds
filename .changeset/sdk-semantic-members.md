---
"@open-federation/sdk": minor
---

Protocol alignment with `@open-federation/lexicon@0.2.0` — semantic member classification (issue #50).

### What consumers should know

The SDK does not currently wrap member endpoints, so **no API surface changes** in this release. This minor bump exists to:

1. Align the SDK protocol version with lexicon 0.2.0 so downstream consumers that pin both packages upgrade together.
2. Flag that the XRPC rename `community.updateMemberRole` → `community.updateMember` is **breaking for anyone using the SDK's raw `client.fetch(...)` escape hatch** to call the old NSID.

### Migration

If your code looks like:

```ts
await client.fetch('/xrpc/net.openfederation.community.updateMemberRole', {
  method: 'POST',
  body: JSON.stringify({ communityDid, memberDid, role: 'moderator' }),
});
```

Rename the NSID:

```diff
- '/xrpc/net.openfederation.community.updateMemberRole'
+ '/xrpc/net.openfederation.community.updateMember'
```

The new endpoint additionally accepts `kind`, `tags`, `attributes`, and `roleRkey` as optional partial-update fields. See the `@open-federation/lexicon@0.2.0` changelog for the full shape.
