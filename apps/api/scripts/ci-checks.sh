#!/usr/bin/env bash
# Runs the integration checks that need no phone or STF (the `test` job of .github/workflows/deploy.yml; also
# usable locally). Real API, real Postgres / Redis / adb server, no mocks. Devices are inert placeholder phones
# (scripts/lib/placeholder.ts); every device is an external phone since redroid was removed (2026-11-20).
#
#   CI_ENV_FILE=<env file> scripts/ci-checks.sh        (from apps/api)
#
# CI_ENV_FILE holds the API's environment (DATABASE_URL, REDIS_URL, JWT_SECRET, ADMIN_PASSWORD, STF_* pointing
# at a closed port, LOG_DIR/ASSET_DIR/UPLOAD_DIR/LIBRARY_DIR in a scratch folder, PG_DUMP_CMD, API_PORT, E2E_API).
# The database is migrated + seeded here. Needs: an adb server on STF_ADB_HOST:STF_ADB_PORT (empty is fine),
# ffmpeg/ffprobe, pg_dump/pg_restore ≥ 17 via PG_DUMP_CMD (Docker only if PG_DUMP_CMD runs it in a container),
# outbound HTTPS (Anthropic / Telegram / YouTube invalid-key checks). Three API starts: A = default platforms, B = persona-prompt's capture listener,
# C = ENABLED_PLATFORMS=all. Stops at the first failing script and prints its output and the API log.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CI_ENV_FILE:?set CI_ENV_FILE}"
# read (never source: values like PG_DUMP_CMD contain spaces) the few values checked here
envval() { sed -n "s/^$1=//p" "$CI_ENV_FILE" | tail -1; }
API_PORT=$(envval API_PORT); DATABASE_URL=$(envval DATABASE_URL); REDIS_URL=$(envval REDIS_URL)
[ -n "$API_PORT" ] || { echo "API_PORT missing in $CI_ENV_FILE" >&2; exit 2; }
case "$DATABASE_URL" in */cloudphone|*/cloudphone\?*) echo "refusing the main database cloudphone" >&2; exit 2 ;; esac
[[ $REDIS_URL =~ /[1-9][0-9]*$ ]] || { echo "REDIS_URL must name a db other than 0" >&2; exit 2; }
[ "$API_PORT" != 3000 ] || { echo "refusing port 3000" >&2; exit 2; }

OUT=${CI_OUT_DIR:-$(mktemp -d)}
mkdir -p "$OUT"
API_PID=""
API_LABEL=""
TIMEOUT=$(command -v timeout || true)

stop_api() {
  [ -n "$API_PID" ] || return 0
  kill "$API_PID" 2>/dev/null || true
  for _ in $(seq 30); do kill -0 "$API_PID" 2>/dev/null || break; sleep 1; done
  kill -9 "$API_PID" 2>/dev/null || true
  API_PID=""
}
trap stop_api EXIT

start_api() { # <label> [VAR=value …]
  local label=$1; shift
  stop_api
  API_LABEL=$label
  echo "::group::API $label"
  env "$@" node --import tsx --env-file="$CI_ENV_FILE" src/main.ts >"$OUT/api-$label.log" 2>&1 &
  API_PID=$!
  for _ in $(seq 90); do
    if curl -sf "http://127.0.0.1:$API_PORT/api/ready" >/dev/null; then echo "API $label up ($*)"; echo "::endgroup::"; return 0; fi
    kill -0 "$API_PID" 2>/dev/null || break
    sleep 1
  done
  echo "::endgroup::"
  echo "API $label did not start"; tail -60 "$OUT/api-$label.log"; exit 1
}

run() { # <name> [VAR=value …]
  local name=$1; shift
  local t0=$SECONDS
  if env "$@" ${TIMEOUT:+$TIMEOUT 1200} node --import tsx --env-file="$CI_ENV_FILE" "scripts/$name-check.ts" >"$OUT/$name.log" 2>&1; then
    echo "✓ $name ($((SECONDS - t0)) s) $(grep -cE '^\s*✓' "$OUT/$name.log" || true) checks"
  else
    echo "✗ $name failed ($((SECONDS - t0)) s)"
    echo "::group::$name output"; cat "$OUT/$name.log"; echo "::endgroup::"
    echo "::group::API log (last 80 lines)"; tail -80 "$OUT/api-$API_LABEL.log"; echo "::endgroup::"
    exit 1
  fi
}

echo "::group::migrate + seed"
node --import tsx --env-file="$CI_ENV_FILE" src/db/migrate.ts
node --import tsx --env-file="$CI_ENV_FILE" src/db/seed.ts
# sysadmin-check proves a restore never reaches the main database "cloudphone" on the same server (read-only
# probe before/after). Where it doesn't exist (CI), create it as an empty, migrated decoy; an existing one (a dev
# machine) is never touched.
MAIN_DB_URL=$(node -e 'const u = new URL(process.argv[1]); u.pathname = "/cloudphone"; console.log(u.toString())' "$DATABASE_URL")
created=$(node --input-type=module -e '
  import postgres from "postgres";
  const admin = postgres(process.argv[1], { max: 1, onnotice: () => {} });
  const [r] = await admin`select count(*)::int as n from pg_database where datname = ${"cloudphone"}`;
  if (!r.n) await admin.unsafe("create database cloudphone");
  await admin.end();
  console.log(r.n ? "exists" : "created");
' "$DATABASE_URL")
if [ "$created" = created ]; then
  DATABASE_URL=$MAIN_DB_URL node --import tsx --env-file="$CI_ENV_FILE" src/db/migrate.ts
  echo "decoy main database cloudphone created (empty, migrated)"
fi
echo "::endgroup::"

# A: default platform scope (captcha last: it uses up this IP's challenge budget for the minute)
start_api A TASKS_TEST_HANDLERS=1
for n in security platforms platform-scope role-menus account-visibility account-sync targets personas persona-drafts \
  content-categories content-batch content-tags-ui translation publish-lang publish-types device-publish risk feed \
  following notifications media media-process required-apps alert-channels tasks sysadmin captcha; do
  run "$n"
done

# B: persona-prompt records what the SDK sends on its own listener
start_api B ANTHROPIC_BASE_URL=http://127.0.0.1:3359
run persona-prompt

# C: every platform (API and scripts)
start_api C ENABLED_PLATFORMS=all TASKS_TEST_HANDLERS=1
for n in dashboard social comments analytics alerts tracked tags-ui content-tools sync-button publish concurrency; do
  run "$n" ENABLED_PLATFORMS=all
done

stop_api
echo "all checks passed (${SECONDS} s)"
