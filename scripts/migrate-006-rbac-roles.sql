-- Migration 006: Expand PDS roles with partner-manager and auditor
--
-- Adds two new roles:
--   partner-manager — can create/list/revoke partner API keys
--   auditor         — read-only access to audit logs, server stats, user lists

ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;
ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check
  CHECK (role IN ('admin', 'moderator', 'partner-manager', 'auditor', 'user'));

-- Grant bootstrap admin the new roles
INSERT INTO user_roles (user_id, role)
SELECT u.id, r.role
FROM users u
CROSS JOIN (VALUES ('partner-manager'), ('auditor')) AS r(role)
JOIN user_roles ur ON ur.user_id = u.id AND ur.role = 'admin'
ON CONFLICT DO NOTHING;
