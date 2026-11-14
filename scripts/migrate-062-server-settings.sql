-- scripts/migrate-062-server-settings.sql
-- Server settings an admin changes on the dashboard, applied without a
-- restart (#410). One row per setting an admin has changed, named by the
-- environment variable it is otherwise read from, holding the value as that
-- variable would. A setting the environment sets wins over its row; removing
-- a row returns the setting to the setup wizard's choice or the default.
-- Nothing secret is ever stored here.
CREATE TABLE IF NOT EXISTS server_settings (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by TEXT
);
