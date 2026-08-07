# Email delivery

The PDS sends transactional email: password resets, account recovery,
session-revocation notices, admin verification challenges. All of it goes
through one SMTP transport (`nodemailer`), so every option below is a matter
of configuration, not code.

Delivery outcomes are recorded in the `email_deliveries` table — that is your
ground truth for "did my mail go out":

```sql
SELECT recipient, purpose, status, error, created_at
FROM email_deliveries ORDER BY created_at DESC LIMIT 20;
```

`/health` reports the transport state (`ok`, `unreachable`, `not-configured`),
verified once at startup.

## Configuration

| Variable | Meaning |
|----------|---------|
| `SMTP_HOST` / `SMTP_PORT` | The transport. Unset = dev mode: mail is logged to the console. |
| `SMTP_SECURE` | `true` for implicit TLS (usually port 465); STARTTLS on 587 needs no flag. |
| `SMTP_USER` / `SMTP_PASSWORD` | Credentials; omit for an unauthenticated relay. |
| `SMTP_FROM` | The From address. Must be on a domain whose SPF/DKIM you control. |
| `ALLOW_NO_EMAIL` | `true` lets production boot without SMTP. Without it, production refuses to start — password reset silently delivering nothing is not a valid production state. |
| `EMAIL_WEBHOOK_TOKEN` | Enables the bounce/complaint webhooks (below). Unset = the routes do not exist. |

In production the server verifies the transport at boot. Unconfigured SMTP is
fatal (unless `ALLOW_NO_EMAIL=true` states the choice); a configured but
unreachable transport logs loudly and shows in `/health`, but does not kill
the server — your mail host being down should not take the PDS with it.

## Option 1: transactional provider (recommended)

Postmark, Resend and AWS SES all speak SMTP. This is the path with working
deliverability on day one — the provider owns IP reputation, DKIM signing and
feedback loops.

```bash
# Postmark
SMTP_HOST=smtp.postmarkapp.com  SMTP_PORT=587  SMTP_USER=<server-token>  SMTP_PASSWORD=<server-token>
# Resend
SMTP_HOST=smtp.resend.com       SMTP_PORT=587  SMTP_USER=resend          SMTP_PASSWORD=<api-key>
# SES
SMTP_HOST=email-smtp.<region>.amazonaws.com  SMTP_PORT=587  SMTP_USER=<smtp-user>  SMTP_PASSWORD=<smtp-pass>
```

Either way: add the provider's SPF include and DKIM records to the `SMTP_FROM`
domain, and set up the bounce webhook (below).

## Option 2: Google Workspace

```bash
SMTP_HOST=smtp.gmail.com  SMTP_PORT=587  SMTP_USER=you@yourdomain  SMTP_PASSWORD=<app-password>
```

Works, with limits worth knowing before choosing it: roughly 2,000
messages/day, the From must be a Workspace address, an app password is
required (2FA on), and there are no bounce webhooks — a hard-bouncing address
keeps being sent to. Reasonable for a small closed instance; outgrown quickly
if registration opens up.

## Option 3: self-hosted (Postfix or similar)

```bash
SMTP_HOST=localhost  SMTP_PORT=25   # or wherever your MTA listens
```

The PDS side is one line. The MTA side is the real work, and it is honest to
list it: a static IP with a matching PTR record, outbound port 25 (blocked on
most PaaS — including Railway — and many VPS providers by default), SPF, DKIM
signing (e.g. opendkim), a DMARC record, TLS, and blocklist monitoring.
Without the PTR/SPF/DKIM triad, major receivers will spam-folder or drop your
mail silently — which looks exactly like the bug this system no longer has.
No bounce webhooks; monitor the local mail queue instead.

## Bounce and complaint webhooks

A hard bounce (address does not exist) or a complaint (marked as spam) adds
the address to `email_suppressions`, and no further mail is sent to it. Soft
bounces are recorded but never suppress — a full mailbox is a moment, not an
address.

Enable by setting a token and pointing your provider at the matching route:

```
EMAIL_WEBHOOK_TOKEN=<long random string>

Postmark → https://<pds>/webhooks/email/postmark?token=<token>   (Bounce + SpamComplaint webhooks)
Resend   → https://<pds>/webhooks/email/resend?token=<token>     (email.bounced + email.complained)
SES      → https://<pds>/webhooks/email/ses?token=<token>        (SNS topic for Bounce + Complaint)
```

SES only: the first SNS delivery is a subscription confirmation. The PDS logs
the `SubscribeURL` for you to open manually — it deliberately does not fetch
URLs supplied by inbound requests.

To un-suppress an address (say, a mailbox that was recreated):

```sql
DELETE FROM email_suppressions WHERE recipient = 'user@example.com';
```

## Email verification

Registration issues a 24-hour single-use verification token and emails a
link (`/verify-email?...`). The link works logged out — the token is the
proof. ATProto-compatible endpoints: `com.atproto.server.confirmEmail`
(redeem; also works without a session, deliberately, see below) and
`com.atproto.server.requestEmailConfirmation` (resend, authenticated,
rate-limited).

What an unverified address blocks is your call:

| `EMAIL_VERIFICATION_POLICY` | Effect |
|---|---|
| `off` | No verification emails, nothing gated. |
| `advisory` (default) | Emails sent, `emailConfirmed` surfaced in `getSession`, nothing gated. |
| `require-for-write` | Unverified accounts can log in and read, but acting endpoints (community membership, wallets, identity keys, creation) return `EmailNotVerified`. |
| `require-for-login` | Unverified local accounts cannot create sessions. Cannot deadlock: `confirmEmail` and the emailed link both work logged out, and the bootstrap admin is marked verified at startup (the operator configured that address themselves). |

An unrecognized value falls back to `advisory` with a warning — a typo must
neither lock users out nor silently disable verification you thought was on.

Note: some corporate mail scanners follow links, which will redeem the
token. That verifies "mail sent to this address reaches its mailbox
infrastructure", which is the property verification exists to establish.

## Dev mode

With `SMTP_HOST` unset, every message is printed to the server console and
recorded in `email_deliveries` with status `not-configured`. Nothing is sent
anywhere.
