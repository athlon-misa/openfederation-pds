---
"@open-federation/sdk": minor
---

`@open-federation/sdk/custody`: `RepoWatcher` notices writes the person's device did not make. It records the device's own commits (`write`, `recordWriteResult`, `recordOwnCommit`) and `check(did)` compares them with the account's public repository, at the PDS or at a relay or mirror, reporting unknown changes with rev, CID, time, the changed records and the signed CAR. `leavePds` points an `assisted` or `self` DID at another PDS with the person's rotation key, without the old PDS; `copyRepo` imports the repository and its blobs into the new one. `readRepoCar`, `verifyRepoCommit` and `revToTime` read and check commits.
