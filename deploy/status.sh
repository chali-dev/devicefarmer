#!/usr/bin/env bash
# status.sh: active colour, recorded versions, what each colour runs, readiness, and recent deploys.
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(dirname "$0")/lib.sh"

read_state
echo "active colour : ${ACTIVE_COLOR:-none}"
echo "history       : ${HISTORY[*]:-none}   (newest first; rollback.sh 1 → ${HISTORY[1]:-n/a}, rollback.sh 2 → ${HISTORY[2]:-n/a})"
echo "proxy         : $(head -1 "$UPSTREAM" 2>/dev/null | sed 's/^# //' || echo 'no upstream yet')"
for c in blue green; do
  echo "--- $c (api :$(port "$c" API), web :$(port "$c" WEB))"
  dc_app "$c" none ps --format '{{.Service}}  {{.Image}}  {{.Status}}' 2>/dev/null | sed '/^$/d; s/^/  /' || true
  body=$(ready_json "$c")
  echo "  ready: ${body:-not answering}"
done
echo "--- shared"
dc_shared ps --format '{{.Service}}  {{.Image}}  {{.Status}}' 2>/dev/null | sed 's/^/  /' || true
echo "--- last deploys"
tail -n 8 "$DEPLOY_LOG" 2>/dev/null | sed 's/^/  /' || echo "  none"
