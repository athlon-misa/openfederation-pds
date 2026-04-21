---
"@open-federation/sdk": patch
---

Fix concurrent refresh-token calls causing accidental session revocation.

When multiple requests hit an expired access token simultaneously, the SDK previously issued multiple refresh calls in parallel. The second call would replay an already-rotated refresh token, which the PDS treats as a compromise signal and revokes all user sessions.

The client now deduplicates in-flight refresh attempts: concurrent callers share a single refresh promise, and the cached promise is cleared in `finally` so a rejection doesn't wedge future refreshes.
