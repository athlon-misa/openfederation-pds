---
"@open-federation/lexicon": minor
---

Import follow-ups (#403): new procedure `net.openfederation.forum.importBlob` (revision 1) stores an attachment of an imported message as a blob of the community's repository. `net.openfederation.forum.importBatch` (revision 2) takes `platform: "slack"`, `embeds` on posts and returns a `deleted` count. `net.openfederation.forum.post` and `forum.thread` (revision 4): `importedFrom.platform` knows `slack`. `net.openfederation.forum.deletePost` (revision 3) takes `community` to delete an imported post. `net.openfederation.invite.create` (revision 3) takes and returns `community` (community invite codes); `net.openfederation.invite.list` (revision 2) shows it. `net.openfederation.account.register` (revision 7) and `account.registerSelfCustody` (revision 4) return `community: { did, status }` when a community invite code was used.
