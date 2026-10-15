#!/usr/bin/env bash
# Run the worker locally without Docker.
#
#   scripts/dev.sh                 # venv, install, ingest data/briefs into ./volume, serve on :8080
#   scripts/dev.sh --no-ingest     # skip the ingest step (reuse ./volume as is)
#   scripts/dev.sh --fresh         # delete ./volume first, then ingest and serve
#
# Settings: reads .env when present, then forces VOLUME_ROOT to ./volume
# (override with DEV_VOLUME_ROOT). PORT defaults to 8080.
# Needs Python 3.11+.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ingest=1
fresh=0
for arg in "$@"; do
  case "$arg" in
    --no-ingest) ingest=0 ;;
    --fresh) fresh=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "dev.sh: unknown option $arg" >&2; exit 2 ;;
  esac
done

PY="${PYTHON:-python3}"
"$PY" - <<'EOF' || { echo "dev.sh: Python 3.11+ required" >&2; exit 1; }
import sys
sys.exit(0 if sys.version_info >= (3, 11) else 1)
EOF

# 1. Environment. .env first, then local overrides.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
export VOLUME_ROOT="${DEV_VOLUME_ROOT:-$ROOT/volume}"
export PORT="${PORT:-8080}"
export MAX_BRIEFS="${MAX_BRIEFS:-30}"
export INGEST_ENABLED="${INGEST_ENABLED:-1}"
export SYNC_TO_SUPABASE="${SYNC_TO_SUPABASE:-0}"
# The .env value points inside the image; use the checkout copy here.
export SEED_DIR="$ROOT/data/briefs"

# 2. Virtualenv and editable install (dev extras include pytest).
if [[ ! -d .venv ]]; then
  echo "dev.sh: creating .venv"
  "$PY" -m venv .venv
fi
# shellcheck disable=SC1091
. .venv/bin/activate
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -e "services/worker[dev]"

# 3. Ingest the samples into the local volume.
if [[ "$fresh" == 1 && -d "$VOLUME_ROOT" ]]; then
  echo "dev.sh: removing $VOLUME_ROOT"
  rm -rf "$VOLUME_ROOT"
fi
mkdir -p "$VOLUME_ROOT"
if [[ "$ingest" == 1 ]]; then
  echo "dev.sh: ingesting data/briefs into $VOLUME_ROOT"
  aegis-worker ingest-dir data/briefs
fi

# 4. Serve.
echo "dev.sh: serving on http://localhost:${PORT} (Ctrl-C to stop)"
exec aegis-worker serve
