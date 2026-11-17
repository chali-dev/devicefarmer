# shellcheck shell=bash disable=SC2034  # variables are used by the scripts that source this file
# Shared helpers of deploy.sh / rollback.sh / status.sh (sourced, not executed). See docs/10-deployment.md.
# Layout (DEPLOY_DIR, default: the parent of this directory, e.g. /srv/cloudphone):
#   deploy/      these scripts, compose files, caddy/Caddyfile (copied by the GitHub workflow)
#   deploy.env   deployment settings (deploy.env.example), app.env  the API's environment (.env.example)
#   state/       state (active colour + last 3 versions), deploy.log, caddy/upstream.caddy, lock
#   data/        the API's var/ (uploads, library, local media, logs), shared by both colours
set -euo pipefail

DEPLOY_BIN=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_DIR=${DEPLOY_DIR:-$(dirname "$DEPLOY_BIN")}
DEPLOY_ENV=${DEPLOY_ENV:-$DEPLOY_DIR/deploy.env}

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s %s\n' "$(ts)" "$*"; }
die() { printf '%s ERROR: %s\n' "$(ts)" "$*" >&2; exit 1; }

[ -f "$DEPLOY_ENV" ] || die "missing $DEPLOY_ENV (copy deploy/deploy.env.example)"
set -a
# shellcheck disable=SC1090
. "$DEPLOY_ENV"
set +a

: "${PROJECT:=cloudphone}"
: "${API_IMAGE:?set API_IMAGE in deploy.env}"
: "${WEB_IMAGE:?set WEB_IMAGE in deploy.env}"
: "${PULL:=1}"
: "${STATE_DIR:=$DEPLOY_DIR/state}"
: "${DATA_DIR:=$DEPLOY_DIR/data}"
: "${APP_ENV_FILE:=$DEPLOY_DIR/app.env}"
: "${PROXY_HTTP_PORT:=80}"
: "${BLUE_API_PORT:=3101}"   "${GREEN_API_PORT:=3102}"
: "${BLUE_RELAY_PORT:=3111}" "${GREEN_RELAY_PORT:=3112}"
: "${BLUE_WEB_PORT:=3201}"   "${GREEN_WEB_PORT:=3202}"
: "${READY_PATH:=/api/ready}"
: "${READY_TIMEOUT:=180}"
: "${DRAIN_SECONDS:=5}"
: "${LEADER_TIMEOUT:=60}"
: "${SEED_ON_DEPLOY:=1}"
: "${PRUNE_IMAGES:=1}"
export PROJECT API_IMAGE WEB_IMAGE STATE_DIR DATA_DIR APP_ENV_FILE PROXY_HTTP_PORT
if [ -z "${DOCKER_GID:-}" ]; then DOCKER_GID=$(stat -c %g /var/run/docker.sock 2>/dev/null || echo 0); fi
export DOCKER_GID

STATE_FILE=$STATE_DIR/state
DEPLOY_LOG=$STATE_DIR/deploy.log
UPSTREAM=$STATE_DIR/caddy/upstream.caddy
VERSION_RE='^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$'

valid_version() { [[ $1 =~ $VERSION_RE ]]; }

# State: plain key=value lines, parsed (never sourced) and validated.
ACTIVE_COLOR=""; HISTORY=()
read_state() {
  ACTIVE_COLOR=""; HISTORY=()
  [ -f "$STATE_FILE" ] || return 0
  local k v
  while IFS='=' read -r k v; do
    case $k in
      ACTIVE_COLOR) [[ $v =~ ^(blue|green)$ ]] && ACTIVE_COLOR=$v ;;
      HISTORY) for x in $v; do valid_version "$x" && HISTORY+=("$x"); done ;;
    esac
  done <"$STATE_FILE"
}
write_state() { # <colour> <versions newest first...> (keeps 3)
  local color=$1; shift
  local tmp="$STATE_FILE.tmp"
  { echo "ACTIVE_COLOR=$color"; echo "HISTORY=${*:1:3}"; echo "UPDATED_AT=$(ts)"; } >"$tmp"
  mv -f "$tmp" "$STATE_FILE"
}
record() { printf '%s %s\n' "$(ts)" "$*" >>"$DEPLOY_LOG"; }

other() { [ "$1" = blue ] && echo green || echo blue; }
port() { local v="${1^^}_${2}_PORT"; echo "${!v}"; } # port <colour> API|WEB|RELAY

lock() {
  mkdir -p "$STATE_DIR/caddy" "$DATA_DIR"
  exec 9>"$STATE_DIR/lock"
  flock -n 9 || die "another deploy/rollback is running"
}

dc_shared() { docker compose --progress quiet -p "$PROJECT" --env-file "$DEPLOY_ENV" -f "$DEPLOY_BIN/compose.shared.yml" "$@"; }
dc_app() { # dc_app <colour> <version, "none" for down> compose args...
  local color=$1 version=$2; shift 2
  COLOR=$color VERSION=$version API_PORT=$(port "$color" API) WEB_PORT=$(port "$color" WEB) RELAY_PORT=$(port "$color" RELAY) \
    docker compose --progress quiet -p "$PROJECT-$color" --env-file "$DEPLOY_ENV" -f "$DEPLOY_BIN/compose.app.yml" "$@"
}

# GET <url> → body on stdout; fails on non-2xx.
http_get() { curl -fsS --max-time 5 "$@"; }
json_field() { sed -n "s/.*\"$1\":\"\\{0,1\\}\\([^\",}]*\\).*/\\1/p" | head -1; } # tiny: flat string/bool fields only

ready_json() { http_get "http://127.0.0.1:$(port "$1" API)$READY_PATH" 2>/dev/null || true; }
