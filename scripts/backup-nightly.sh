#!/bin/zsh
# Nightly backup of the live BSMNT Supabase project to ~/BSMNT-backups (this Mac only).
#
#   - db/<stamp>-schema.sql.gz   structure (tables, RLS policies, functions)
#   - db/<stamp>-data.sql.gz     all public data (app_state, members, Flight Ops, shares…)
#   - db/<stamp>-auth.sql.gz     sign-in accounts
#   - storage/<bucket>/…         uploaded files (one growing mirror; deleted files are kept)
#
# Keeps 30 days of database dumps. Uses the Supabase CLI login and the project linked in
# weekbelow-server/supabase (no keys in this file). `supabase db dump` runs pg_dump in Docker,
# so Colima is started if it isn't running. Scheduled by
# ~/Library/LaunchAgents/nz.co.belowstudios.bsmnt-backup.plist (02:00, or at the next wake).
#
# Run by hand:  ~/Developer/weekbelow-server/scripts/backup-nightly.sh

set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
umask 077

ROOT="$HOME/BSMNT-backups"
DB="$ROOT/db"
FILES="$ROOT/storage"
LOGS="$ROOT/logs"
KEEP_DAYS=30
PROJECT_DIR="$HOME/Developer/weekbelow-server"
STAMP=$(date +%Y%m%d-%H%M)
LOG="$LOGS/$STAMP.log"

mkdir -p "$DB" "$FILES" "$LOGS"
exec >>"$LOG" 2>&1
echo "== BSMNT backup $STAMP"

fail() {
  echo "FAILED: $1"
  osascript -e "display notification \"$1 - see ~/BSMNT-backups/logs\" with title \"BSMNT backup failed\"" 2>/dev/null
  exit 1
}

cd "$PROJECT_DIR" || fail "weekbelow-server folder missing"
[[ -f supabase/.temp/project-ref ]] || fail "Supabase project not linked (run: supabase link)"

# pg_dump runs in a container.
if ! docker info >/dev/null 2>&1; then
  echo "Starting Colima…"
  colima start >/dev/null 2>&1 || fail "could not start Colima (Docker)"
fi

dump() {   # name, flags…
  local name=$1; shift
  local out="$DB/$STAMP-$name.sql"
  supabase db dump "$@" -f "$out" || { rm -f "$out"; fail "database dump ($name)"; }
  [[ -s "$out" ]] || { rm -f "$out"; fail "database dump ($name) was empty"; }
  gzip -9 "$out" && gzip -t "$out.gz" || fail "compressing $name"
  echo "ok $name $(du -h "$out.gz" | cut -f1)"
}
dump schema
dump data --data-only
dump auth --data-only --schema auth

# Sanity check: the data dump must contain every studio record and member.
for t in app_state agency_members agencies; do
  # (zgrep, not gzip | grep -q: with pipefail, grep stopping early made the pipe "fail")
  zgrep -qF "INSERT INTO \"public\".\"$t\"" "$DB/$STAMP-data.sql.gz" || fail "data dump has no $t rows"
done

# Uploaded files: mirror each bucket (new files added; nothing is ever deleted here).
for b in $(supabase storage ls ss:/// --experimental --linked 2>/dev/null \
           | python3 -c 'import sys,json; print(" ".join(p.strip("/") for p in json.load(sys.stdin).get("paths",[])))'); do
  mkdir -p "$FILES/$b"
  supabase storage cp -r "ss:///$b" "$FILES/$b" --experimental --linked >/dev/null 2>&1 \
    || echo "warning: bucket $b copy had errors (continuing)"
done
echo "ok storage $(find "$FILES" -type f | wc -l | tr -d ' ') files, $(du -sh "$FILES" | cut -f1)"

# Retention.
find "$DB" -name '*.sql.gz' -mtime +$KEEP_DAYS -delete
find "$LOGS" -name '*.log' -mtime +$KEEP_DAYS -delete
date +%s > "$ROOT/.last-success"
echo "== done $(date +%H:%M:%S)"
