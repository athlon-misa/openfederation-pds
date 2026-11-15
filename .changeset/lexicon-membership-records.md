---
"@open-federation/lexicon": minor
---

Membership records in the member's own repo (#385): new record `net.openfederation.community.membership` (`{ community, createdAt }`, rkey = the community's DID, revision 1). `community.join` returns `homeRecord` (revision 5), `community.leave` returns `homeRecord` (revision 3), and `community.update` returns `membershipRecords` when the community is private after the update (revision 5).
