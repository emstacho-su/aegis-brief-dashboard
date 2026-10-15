#!/bin/sh
# Seed an empty volume from SEED_DIR (default /app/data/briefs, the fictional samples)
# before running the command. Set SEED_DIR="" to disable seeding.
set -eu
if [ -n "${SEED_DIR:-}" ] && [ -d "${SEED_DIR}" ]; then
  aegis-worker ingest-dir --if-empty "${SEED_DIR}"
fi
exec "$@"
