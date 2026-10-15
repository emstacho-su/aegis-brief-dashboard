#!/usr/bin/env bash
# Simulate daily arrival: ingest the next brief the volume has not seen yet.
#
#   scripts/replay.sh               # one step from data/briefs
#   scripts/replay.sh 5             # five steps
#   scripts/replay.sh 1 data/inbox  # one step from another host directory
#
# Wraps: docker compose --profile replay run --rm replay
# The running dashboard shares the volume and sees each new brief.
# To replay from an empty archive, start the stack with SEED_DIR= (empty);
# see docs/RUNBOOK.md "Replay".
set -euo pipefail

cd "$(dirname "$0")/.."

steps="${1:-1}"
if [[ $# -ge 2 ]]; then
  export REPLAY_SOURCE="$2"
fi

if ! [[ "$steps" =~ ^[0-9]+$ ]] || [[ "$steps" -lt 1 ]]; then
  echo "usage: scripts/replay.sh [steps>=1] [host-dir]" >&2
  exit 2
fi

for ((i = 1; i <= steps; i++)); do
  echo "replay: step $i of $steps"
  docker compose --profile replay run --rm replay
done
