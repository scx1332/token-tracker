#!/usr/bin/env bash
#
# Daily backup of the tokens database: plain SQL dump, 7z-compressed.
#
# Plain SQL on purpose. A text dump can be read, grepped and partly salvaged if
# it ever goes bad, and restoring it never depends on having a matching
# pg_restore build around. The dump is taken *inside* the postgres container, so
# pg_dump always matches the server version, whatever the host has installed.
#
# Compression is PPMd rather than 7z's default LZMA2. Measured on a real 27 MB
# dump: PPMd -mo=32 -mmem=256m gave 1.44 MB in 1.2 s, LZMA2 -mx=9 -md=64m gave
# 1.54 MB in 7.3 s. Text is what PPMd is for.
#
#   ./scripts/backup-db.sh                    # run it now
#   BACKUP_DIR=/mnt/other ./scripts/backup-db.sh
#   BACKUP_KEEP_DAYS=90 ./scripts/backup-db.sh
#
# Check an old archive is still sound (CRC per file, no extraction):
#   7z t /home/ubuntu/backups/token-tracker/tokens-2026-08-15.sql.7z
#
# Restore, from the compose project directory:
#   7z x -so /home/ubuntu/backups/token-tracker/tokens-2026-08-15.sql.7z \
#     | docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'
#
# The dump carries DROP ... IF EXISTS for everything it recreates, so it also
# restores over a live database — destructive by design, and the reason each
# archive is round-tripped and compared before yesterday's is eligible to be
# pruned.

set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu/backups/token-tracker}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"

mkdir -p -- "$BACKUP_DIR"
LOG="$BACKUP_DIR/backup.log"

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }
die() { log "FAILED: $*"; exit 1; }

# One at a time. A cron tick that lands on a still-running backup steps aside
# rather than fighting it for the same filenames.
exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || { log "skipped: another backup holds the lock"; exit 0; }

stamp="$(date -u +%Y-%m-%d)"
sql="$BACKUP_DIR/tokens-$stamp.sql"
archive="$BACKUP_DIR/tokens-$stamp.sql.7z"
part="$archive.part"
trap 'rm -f -- "$sql" "$part"' EXIT

cd -- "$PROJECT_DIR"

log "dumping $stamp"
docker compose exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=plain --no-owner --no-privileges --clean --if-exists' \
  >"$sql" || die "pg_dump exited non-zero"

# pg_dump writes this line last and only on success. Without the check, a dump
# cut short (disk full, container killed mid-stream) still leaves a file that
# looks perfectly plausible until the day you need it.
grep -q '^-- PostgreSQL database dump complete' -- "$sql" || die "dump has no completion marker"
sql_bytes=$(stat -c%s -- "$sql")

rm -f -- "$part"
7z a -t7z -m0=PPMd -mx=9 -mo=32 -mmem=256m -bso0 -bsp0 -- "$part" "$sql" >/dev/null \
  || die "7z exited non-zero"

# Decompress the archive we just wrote and compare it against what went in.
# Stronger than `7z t`, which only says the bytes are the bytes it stored.
want=$(sha256sum <"$sql" | cut -d' ' -f1)
got=$(7z x -so -- "$part" 2>/dev/null | sha256sum | cut -d' ' -f1)
[ "$want" = "$got" ] || die "archive does not round-trip to the dump it came from"

mv -f -- "$part" "$archive"
rm -f -- "$sql"

arc_bytes=$(stat -c%s -- "$archive")
log "OK tokens-$stamp.sql.7z — $((sql_bytes / 1048576)) MB SQL to $((arc_bytes / 1024)) KB ($((sql_bytes / arc_bytes))x)"

# Keep KEEP_DAYS of dailies; keep every first-of-month indefinitely, so a
# problem noticed months late still has something older than the window to
# compare against. At ~1.5 MB an archive, the monthlies cost nothing.
pruned=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'tokens-*.sql.7z' \
  ! -name 'tokens-*-01.sql.7z' -mtime +"$KEEP_DAYS" -print -delete | wc -l)
kept=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'tokens-*.sql.7z' | wc -l)
log "retention: pruned $pruned, kept $kept, $(du -sh -- "$BACKUP_DIR" | cut -f1) on disk"
