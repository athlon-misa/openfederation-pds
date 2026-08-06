#!/usr/bin/env bash
#
# Applies the governance index migrations (035, 036, 037) to an existing
# database.
#
# `ensureSchema()` only runs schema.sql when the `users` table is missing, so an
# existing deployment never picks these up on its own.
#
# Safe to run against a live PDS: the indexes are built CONCURRENTLY, so writes
# are not blocked, and every statement is IF NOT EXISTS, so re-running is a
# no-op. Reads the same DB_* variables the server uses.
#
#   railway run bash scripts/apply-governance-indexes.sh   # on Railway
#   bash scripts/apply-governance-indexes.sh               # anywhere else

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MIGRATIONS=(
  "migrate-035-governance-vote-record-index.sql"
  "migrate-036-governance-objection-index.sql"
  "migrate-037-governance-anchor-audit-index.sql"
)

: "${DB_HOST:?DB_HOST is not set. On Railway, run this via: railway run bash scripts/apply-governance-indexes.sh}"
: "${DB_NAME:?DB_NAME is not set}"
: "${DB_USER:?DB_USER is not set}"
DB_PORT="${DB_PORT:-5432}"

# psql reads this rather than prompting; unset means "no password needed".
if [ -n "${DB_PASSWORD:-}" ]; then
  export PGPASSWORD="$DB_PASSWORD"
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "error: psql not found on PATH." >&2
  echo "  macOS:  brew install postgresql@15" >&2
  echo "  Debian: apt-get install postgresql-client" >&2
  echo "  Or use Railway's own session instead: railway connect Postgres" >&2
  exit 1
fi

psql_do() {
  # NOTICE is suppressed because "already exists, skipping" is the expected
  # output of a re-run, not something to alarm the operator. Real failures still
  # surface: every statement runs under ON_ERROR_STOP, and the verification pass
  # below confirms each index independently rather than trusting psql's output.
  PGOPTIONS="--client-min-messages=warning" \
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"
}

echo "Target: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

if ! psql_do -qtAc "SELECT 1" >/dev/null 2>&1; then
  echo "error: cannot connect. Check the DB_* variables and that this host is reachable." >&2
  exit 1
fi

# A previous interrupted CONCURRENTLY build leaves an INVALID index that blocks
# the retry, so surface it before doing anything rather than failing midway.
invalid="$(psql_do -qtAc \
  "SELECT string_agg(indexrelid::regclass::text, ', ') FROM pg_index WHERE NOT indisvalid;")"
if [ -n "$invalid" ]; then
  echo "error: this database has invalid indexes from an earlier interrupted run:" >&2
  echo "         $invalid" >&2
  echo "       Drop them, then run this again:" >&2
  for idx in ${invalid//,/ }; do echo "         DROP INDEX IF EXISTS $idx;" >&2; done
  exit 1
fi

echo "Applying ${#MIGRATIONS[@]} migrations (built CONCURRENTLY; writes are not blocked)..."
for m in "${MIGRATIONS[@]}"; do
  printf '  %-52s' "$m"
  psql_do -q -f "${SCRIPT_DIR}/${m}" 2>&1 | sed 's/^/    /' | grep -v '^ *$' || true
  echo "ok"
done

echo
echo "Verifying..."
missing=0
for idx in idx_records_governance_vote_proposal \
           idx_records_governance_objection_proposal \
           idx_audit_log_decision_anchor_target; do
  found="$(psql_do -qtAc "SELECT count(*) FROM pg_indexes WHERE indexname = '$idx';")"
  if [ "$found" = "1" ]; then
    echo "  present  $idx"
  else
    echo "  MISSING  $idx" >&2
    missing=1
  fi
done

still_invalid="$(psql_do -qtAc \
  "SELECT string_agg(indexrelid::regclass::text, ', ') FROM pg_index WHERE NOT indisvalid;")"
if [ -n "$still_invalid" ]; then
  echo "  warning: index build did not complete cleanly: $still_invalid" >&2
  echo "           Drop those and re-run." >&2
  missing=1
fi

if [ "$missing" != "0" ]; then
  echo "Did not finish cleanly — see above." >&2
  exit 1
fi

echo
echo "Done. All three governance indexes are in place."
