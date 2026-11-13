---
"@open-federation/pseudonym": minor
---

A verifier that runs anywhere, including browsers and phones: `verifyRevealBundle` (online, it reports `ownerAttestation`: `person` when the owner's own key signed, `pds-held-key` when their server's did), `verifyPresence`, `checkPresence` and `fetchGenesisOp`, reading every key from the PLC directory. `challengeForWord(word, context)` turns a spoken word into a presence challenge. For QR codes, `revealLinkFragment` and `presenceLinkFragment` put a proof in a short URL fragment, `parseVerifyLink` and `revealBundleFromLink` read it back, and `verifyLink` checks it and names both accounts by handle.
