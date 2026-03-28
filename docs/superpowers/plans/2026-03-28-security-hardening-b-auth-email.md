# Security Hardening Plan B: Auth Hardening + Email Service

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-account brute-force protection, session introspection/revocation endpoints, email service infrastructure, and self-service password reset.

**Architecture:** These features are coupled: session revocation is needed by both session management and password reset; password reset needs the email service. Build them bottom-up: email service first, then brute force protection, then session management, then password reset.

**Tech Stack:** TypeScript, PostgreSQL, Nodemailer (email), Express.js

**Depends on:** Plan A should be deployed first (audit logging for failed logins is used by brute-force detection).

---

## Task 1: Email service infrastructure

**New files:**
- `src/email/email-service.ts` — send emails via SMTP (Nodemailer)
- `src/email/templates.ts` — HTML email templates (password reset, security alerts)

**Modified files:**
- `src/config.ts` — add email config (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM)
- `package.json` — add `nodemailer` dependency

**Scope:**
- SMTP transport via Nodemailer (works with any provider: SendGrid, SES, Postmark, Gmail)
- `sendEmail(to, subject, html)` function
- Password reset email template
- Security alert email template (for session revocation, password change)
- Config: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_ENABLED`
- When `SMTP_ENABLED=false` (default), emails are logged to console instead of sent (dev mode)

## Task 2: Per-account brute-force protection

**New files:**
- `scripts/migrate-009-login-protection.sql` — add columns + index

**Modified files:**
- `src/api/com.atproto.server.createSession.ts` — check/increment/reset counters
- `src/db/schema.sql` — add columns to users table definition

**Scope:**
- Add `failed_login_attempts` (int, default 0) and `locked_until` (timestamptz, nullable) to `users` table
- On failed password check: increment counter, set exponential lockout after 5 failures (1min → 5min → 30min → 2hr)
- On successful login: reset counter to 0
- Before password check: if `locked_until > NOW()`, reject with `AccountLocked` error and time remaining
- Audit log entry includes attempt count

## Task 3: Session introspection and revocation

**New files:**
- `src/api/net.openfederation.account.listSessions.ts`
- `src/api/net.openfederation.account.revokeSession.ts`
- `src/lexicon/net.openfederation.account.listSessions.json`
- `src/lexicon/net.openfederation.account.revokeSession.json`

**Modified files:**
- `src/server/index.ts` — register new handlers
- `src/db/audit.ts` — add `session.revoke` action
- `cli/ofc.ts` — add `account sessions list`, `account sessions revoke`, `account sessions revoke-all`

**Scope:**
- `listSessions`: returns active sessions for the authenticated user (id prefix, created_at, last_used_at, expires_at). Admin can list any user's sessions by DID.
- `revokeSession`: revoke a specific session by ID (self or admin). Also supports `revokeAll: true` to revoke all sessions except current.
- Send security alert email when sessions are revoked (if email enabled)
- CLI commands: `ofc account sessions list`, `ofc account sessions revoke <id>`, `ofc account sessions revoke-all`

## Task 4: Self-service password reset

**New files:**
- `src/api/net.openfederation.account.requestPasswordReset.ts`
- `src/api/net.openfederation.account.confirmPasswordReset.ts`
- `src/lexicon/net.openfederation.account.requestPasswordReset.json`
- `src/lexicon/net.openfederation.account.confirmPasswordReset.json`
- `scripts/migrate-010-password-reset.sql` — password_reset_tokens table

**Modified files:**
- `src/server/index.ts` — register new handlers
- `src/db/audit.ts` — add `account.password.reset.request`, `account.password.reset.confirm` actions

**Scope:**
- `requestPasswordReset`: accepts email/handle, generates a random 64-byte token, hashes it (SHA-256), stores in DB with 1-hour expiry. Sends email with reset link. Rate limited (3/hr per email).
- `confirmPasswordReset`: accepts token + new password, verifies token exists and is not expired, updates password, revokes all sessions, deletes token. Audit logged.
- `password_reset_tokens` table: id, user_id, token_hash, expires_at, created_at
- Admin CLI: `ofc admin account reset-password <handle>` — triggers reset email
- Always returns success on request (don't leak email existence)

## Task 5: CLI enhancements

**Modified files:**
- `cli/ofc.ts`

**Scope:**
- `ofc security check-config` — validates server config for common misconfigurations (JWT secret length, KEY_ENCRYPTION_SECRET set, DB_SSL, NODE_ENV, etc.)
- `ofc security audit-summary [--days N]` — summarizes recent security events from audit log (failed logins, token reuse, role changes, transfers, etc.)

## Task 6: Integration tests + verification

**Scope:**
- Tests for brute-force lockout and reset
- Tests for session list/revoke
- Tests for password reset flow (with email disabled — console logging)
- CI verification
