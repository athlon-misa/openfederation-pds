---
"@open-federation/sdk": minor
---

Device signing in `@open-federation/sdk/custody` (#240): `generateDeviceRepoKey`, `enableDeviceSigning` / `disableDeviceSigning` / `setDeviceRepoKey` (phrase-signed PLC updates of the DID's `atproto` key), and `deviceCreateRecord` / `devicePutRecord` / `deviceDeleteRecord` / `deviceApplyWrites`, which prepare a commit on the PDS, check that the new tree holds exactly the device's writes (`verifyPreparedCommit`), sign it on the device and submit it. Also `listMstRecords` and `repoRecordCid`.
