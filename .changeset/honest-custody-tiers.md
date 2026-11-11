---
"@open-federation/sdk": minor
---

Custody tiers are named for what they are (#239): every tier is custodial. `SecurityLevel.tierName` is now `'custodial' | 'escrow-recorded' | 'key-exported'` and `SecurityLevel.pdsHoldsRotationKey` is new. `exportRecoveryKey()` now returns the account's PLC rotation key (`rotationKey`, base64) instead of a single Shamir share that could not be used on its own; `registerEscrow()` returns `shareStoredHere: true`.
