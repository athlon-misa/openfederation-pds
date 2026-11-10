# Security Policy

OpenFederation PDS is maintained by the **Resonator Foundation**.

## Reporting a vulnerability

Please do not open a public issue.

- Use **"Report a vulnerability"** on this repository's [Security tab](https://github.com/athlon-misa/openfederation-pds/security/advisories/new) (private to the maintainers), or
- email **security@openfederation.net**.

Include what you found, how to reproduce it, the affected version or commit, and the impact you expect.

## What to expect

| Step | When |
| --- | --- |
| Acknowledgement | Within 48 hours |
| First assessment | Within 7 days |
| Fix or mitigation, critical or actively exploited | Within 7 days |
| Fix or mitigation, high | Within 30 days |
| Fix or mitigation, moderate | Within 90 days |
| Public advisory | With the fix, or 90 days after the report at the latest, coordinated with you |

We credit reporters unless you prefer otherwise. We will not take legal action against research carried out in good faith within this policy.

## Supported versions

| Version | Security updates until |
| --- | --- |
| 1.x (latest release) | At least 11 November 2031 |

Security fixes go into a new release of the current major version and are marked **Security** in [`CHANGELOG.md`](CHANGELOG.md). Older releases stay available for download. There are no backport branches; upgrade to the latest release.

## Scope

In scope: the PDS server, the admin dashboard (`web-interface/`), the PLC directory wrapper (`plc-server/`), the CLI, the Matrix bridge, the `@open-federation/*` npm packages, and vulnerabilities in third-party dependencies as they affect any of these. For a dependency issue, please also report it upstream.

Out of scope: social engineering, attacks needing physical access to a server, and volumetric denial of service.

## Advisories

Fixed vulnerabilities are published as [GitHub Security Advisories](https://github.com/athlon-misa/openfederation-pds/security/advisories) for this repository. Each release carries a CycloneDX SBOM per component.

## For operators

Actively exploited vulnerabilities and severe incidents are reported to the EU authorities as the Cyber Resilience Act requires. We also publish a notice here and in the release notes saying what to do.

A running PDS serves its own contact details at `/.well-known/security.txt` (RFC 9116); set `SECURITY_CONTACT` to point it at your instance's security contact.
