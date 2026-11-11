---
"@open-federation/sdk": minor
---

`@open-federation/sdk/custody`: person-signed records (ADR-003, decision 11). `signRecord` / `signRecordWithPasskey` add `ownerSig` (the owner key's signature over the record's CID, DID and collection); `verifyOwnerRecord`, `recordCid` and `ownerRecordText` check it.
