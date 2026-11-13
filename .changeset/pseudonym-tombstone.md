---
"@open-federation/pseudonym": minor
---

`tombstone({ plcUrl, did, phrase })` ends a pseudonym's DID in the PLC directory: it signs a `plc_tombstone` operation with the twelve words (the DID's only rotation key) and posts it, refusing first when the DID is already tombstoned or the words are not its rotation key. `buildTombstoneOp` and `signTombstoneOp` are exported too. Delete the pseudonym's accounts before tombstoning: servers check the owner-key JWT against the DID's current rotation keys.
