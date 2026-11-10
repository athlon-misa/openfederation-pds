-- scripts/migrate-050-scheduler-runs.sql
-- When each periodic background job last ran. Kept in the database so the
-- schedule survives restarts and is shared by every server process, instead of
-- living in one process's timer.
CREATE TABLE IF NOT EXISTS scheduler_runs (
    name VARCHAR(128) PRIMARY KEY,
    last_run_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
