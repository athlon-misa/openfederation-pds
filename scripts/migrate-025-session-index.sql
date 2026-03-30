-- Performance: add missing index on sessions.refresh_token_hash
-- Every token refresh and reuse check queries by this column.
-- Without this index, every refreshSession call does a full table scan.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_refresh_hash
  ON sessions(refresh_token_hash);
