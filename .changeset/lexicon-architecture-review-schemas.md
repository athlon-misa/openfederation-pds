---
"@open-federation/lexicon": minor
---

Sync schemas with `src/lexicon/` after the architecture review (issues #54–#60).

### Headline

- **Extended:** `net.openfederation.community.get` output gains an optional `myMembership` field carrying the caller's Membership shape — `status`, `role`, `roleRkey`, `kind`, `tags`, `attributes`, `joinRequestStatus` (closes consumer N+1 calls; see #56). Schema revision bumped to 2; the field is optional, so existing readers keep working.

### Other lexicon updates absorbed in this bump

Schemas touched by the typed-XRPC-errors work (#54) and related lifecycle / wallet / vault work — added or tightened declared error codes, `revision` bumps where shape changed:

- Community: `join`, `update`, `updateMember`, `updateRole`, `revokeDelegation`, `setDelegation`, `setGovernanceModel`
- Account: `register`, `getSecurityLevel`, `listSessions`
- Admin: `deleteExportSchedule`, `importRepo`
- Vault / Wallet: `vault.getCustodialSecret`, `wallet.finalizeTierChange`, `wallet.retrieveForUpgrade`, `wallet.sign`

All changes are additive at the schema level; readers that ignore unknown fields and treat declared error codes as a closed-but-extensible set are unaffected.

### Why a republish was needed

`packages/openfederation-lexicon/schemas/` is regenerated from `src/lexicon/` by `pnpm build:lexicon` and gitignored. The architecture-review commit (`cc3bfa6`) modified `src/lexicon/` but no changeset was added, so the release pipeline didn't ship the changes. This changeset corrects that.

### Consumer impact

- `@grvty/api-client` consumers in `grvty-web` already read the `myMembership` field via the BFF — no consumer-side action required for that path.
- SDK and React packages are unchanged (no source-dir commits since `0.2.0` / `0.1.1`); not bumping.
