---
"@open-federation/sdk": patch
---

Guard outbound `did:web` resolution during offline sign-in verification (issue #97).

`verifySignInAssertion` takes the issuer from an unverified JWT payload, so a caller could name any `did:web` host and make the verifying backend fetch it before any signature was checked — a blind SSRF primitive reaching internal HTTPS services and cloud metadata endpoints.

The DID document fetch is now validated on every hop: HTTPS only, no embedded credentials, private/loopback/link-local/reserved addresses refused, redirects followed manually and re-validated rather than trusted, and the response bounded in both size and time. On Node the hostname is additionally resolved and every address it maps to is re-checked, which is the only way to catch a public name pointing inward.

`did:web` remains fully supported — legitimate public issuers resolve exactly as before. `did:plc` resolution against the integrator-supplied `plcUrl` is deliberately unguarded, so self-hosted and local directories keep working.

New optional `network` field on `VerifySignInOptions` tunes the timeout, response cap and redirect budget. The guard itself is not opt-in.
