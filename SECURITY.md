# Security Policy

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

If you discover a security vulnerability in OpenFederation PDS, please report it responsibly by emailing:

**security@openfederation.net**

Include as much of the following as possible:

- Description of the vulnerability
- Steps to reproduce or proof of concept
- Affected versions or components
- Potential impact assessment

## What to Expect

- **Acknowledgment** within 48 hours of your report
- **Status update** within 7 days with an initial assessment
- **Resolution timeline** communicated once the issue is confirmed

We will coordinate disclosure with you once a fix is available. Credit will be given to reporters unless anonymity is requested.

## Scope

The following are in scope for security reports:

- Authentication and session management (JWT, refresh tokens, token rotation)
- Key management (signing keys, recovery keys, encryption at rest)
- Authorization bypass (role checks, community permissions)
- Injection vulnerabilities (SQL injection, XSS, command injection)
- Cryptographic weaknesses
- Partner API key security
- Data exposure (audit logs, user data, community data)
- AT Protocol compliance issues with security implications

## Out of Scope

- Denial of service via rate limiting exhaustion (rate limits are configurable)
- Issues in third-party dependencies (report these upstream, but let us know)
- Social engineering attacks
- Issues requiring physical access to the server

## Supported Versions

Security fixes are applied to the latest release on `main`. We do not maintain backport branches at this time.
