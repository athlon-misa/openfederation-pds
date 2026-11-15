---
"@open-federation/lexicon": minor
---

Device signing, phase 2 (#240): new procedure `net.openfederation.repo.prepareAction` (revision 1) prepares the write a method makes for the person (profile, contacts, forum, RSVPs, votes, objections) for the device to sign. `net.openfederation.repo.submitCommit` (revision 2) also finishes those: `commit` and `writes` become optional, `signed` and `result` are added, and the `ActionChanged` error. `net.openfederation.identity.signInAssert` (revision 3) takes `signOnDevice` and may return `unsignedDidToken` instead of `didToken`.
