-- scripts/migrate-049-external-user-email-null.sql
-- External ("Sign in with ATProto") accounts were stored with email = ''.
-- users.email is UNIQUE, so only one such account could ever exist; the second
-- sign-in failed on the constraint. No email is NULL.
UPDATE users SET email = NULL WHERE email = '';
