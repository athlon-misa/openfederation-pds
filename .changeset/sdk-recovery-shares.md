---
"@open-federation/sdk": minor
---

`@open-federation/sdk/custody` splits a recovery phrase among people the person trusts (#238): `splitRecoveryPhrase(phrase, { threshold, shares })` makes k-of-n Shamir shares (GF(256), 2 ≤ k ≤ n ≤ 16) of the phrase's 16 bytes of entropy, and `combineRecoveryShares(shares)` gives back the exact phrase from any k of them. A share carries a format version, the threshold, its index, a random split id and a checksum, and is printable as 20 BIP-39 words (`words`) or as an `OFRS:` base32 code for a QR code (`code`); `parseRecoveryShare(text)` reads either. Damaged shares, shares from different splits, the same share twice and too few shares are refused with a `RecoveryShareError` whose `code` says which (`ShareChecksumMismatch`, `MixedShares`, `DuplicateShare`, `NotEnoughShares`, `InvalidShare`, `UnsupportedShareVersion`, `InvalidSplit`). No new dependency.
