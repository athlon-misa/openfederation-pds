---
"@open-federation/sdk": minor
---

Security release to match OpenFederation PDS 1.4.0.

- **Breaking:** `wallet.grantConsent` is gone; the PDS no longer lets a dApp grant itself signing consent. Use `wallet.requestConsent` (returns an `approveUrl` on the PDS where the user approves with their password), then `wallet.waitForConsent` or `wallet.getConsentRequest`. Consents name `allowedContracts` and value limits.
- **Breaking:** the ATProto login redirect requires `code_challenge`; the SDK sends one and binds the callback to the browser that started the login.
- Partner registration tickets: `createPartnerTicket` and `generatePartnerTicketKey` for partners whose key requires a ticket.
- Concurrent token refreshes are coordinated (two tabs or a transient failure no longer log the user out).
- Byte-message signing fixed; `resolveWallet` is public; `sessionFromWrappedSecret` for Tier 2 wallets; SIWOF verification uses safer defaults (PLC directory list, timeout, IPv6 checks).
