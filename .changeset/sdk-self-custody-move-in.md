---
"@open-federation/sdk": minor
---

Moving a `self` or `assisted` account into another OpenFederation PDS with the phrase alone, without the old PDS (#382, ADR-004), in `@open-federation/sdk/custody`: `moveIn` (open the account with the top rotation key, import the backup's repository and blobs, check, `leavePds` if the DID doesn't point there yet, activate, sign in), `downloadBackup` (repository and every blob, to save before `leavePds`), `openAccountWithRotationKey`, `signRotationKeyJwt` and `reserveSigningKeyAt`. `copyRepo` takes `backupBlobs` and `allowMissingBlobs` (missing ones are returned in `missingBlobs`) and pages `listMissingBlobs` by cursor.
