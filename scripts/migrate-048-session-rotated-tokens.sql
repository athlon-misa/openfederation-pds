-- scripts/migrate-048-session-rotated-tokens.sql
-- Every refresh token a session has rotated away, not just the last one.
-- sessions.previous_token_hash remembers a single predecessor, so a stolen
-- token replayed after two rotations matched nothing and nothing was revoked.
CREATE TABLE IF NOT EXISTS session_rotated_tokens (
    token_hash VARCHAR(255) PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    -- NULL for pseudonym sessions, which never record when they were used
    rotated_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_session_rotated_tokens_session ON session_rotated_tokens(session_id);

INSERT INTO session_rotated_tokens (token_hash, session_id, rotated_at)
SELECT previous_token_hash, id, last_used_at FROM sessions WHERE previous_token_hash IS NOT NULL
ON CONFLICT (token_hash) DO NOTHING;
