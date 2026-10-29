-- scripts/migrate-044-custodial-migration.sql
-- Custodial account migration (#266).
-- The public half of the rotation key this PDS made for an account that is
-- moving here; recommended to the old PDS for the PLC update.
ALTER TABLE users ADD COLUMN IF NOT EXISTS rotation_did_key TEXT;

-- One-time emailed codes that let the old PDS sign a PLC operation with the
-- rotation key it holds for the user (com.atproto.identity.signPlcOperation).
CREATE TABLE IF NOT EXISTS plc_operation_tokens (
    id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_plc_operation_tokens_user ON plc_operation_tokens(user_id);
