-- Migration 012: Invite code binding to specific email
ALTER TABLE invites ADD COLUMN IF NOT EXISTS bound_to VARCHAR(255);
ALTER TABLE invites ADD COLUMN IF NOT EXISTS note TEXT;
