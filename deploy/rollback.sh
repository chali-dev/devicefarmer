#!/usr/bin/env bash
# rollback.sh <1|2>: re-deploys the version recorded N steps back through the same blue-green path
# (deploy.sh, migrations included: they are backward compatible and never undone). Afterwards the
# versions rolled back from are dropped from the history. Refuses to go past what is recorded.
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(dirname "$0")/lib.sh"

STEPS=${1:-}
[[ $STEPS =~ ^[12]$ ]] || die "usage: rollback.sh <1|2>"
read_state
[ "${#HISTORY[@]}" -gt 0 ] || die "nothing deployed yet (no history in $STATE_FILE)"
TARGET_VERSION=${HISTORY[$STEPS]:-}
if [ -z "$TARGET_VERSION" ]; then
  record "refused rollback steps=$STEPS history=${HISTORY[*]}"
  die "cannot roll back $STEPS step(s): only ${#HISTORY[@]} version(s) recorded (newest first: ${HISTORY[*]})"
fi
log "rollback $STEPS step(s): ${HISTORY[0]} → $TARGET_VERSION"
exec "$DEPLOY_BIN/deploy.sh" --rollback "$STEPS" "$TARGET_VERSION"
