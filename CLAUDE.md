# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Cloud-phone management platform: a Node.js/TypeScript control plane that manages Android containers (redroid) on a Linux host and reuses DeviceFarmer STF for device management and remote control. npm workspaces monorepo: `apps/api` (Fastify), `apps/web` (Vite + Vue 3 Composition API + Ant Design Vue + Pinia). UI text and docs are in Chinese.

## Commands

```bash
# Dev dependencies (Postgres on 5432, Redis on 6380: 6379 is taken on this machine)
docker compose -f docker-compose.dev.yml up -d
docker compose -f infra/stf/docker-compose.yml up -d --build   # STF + RethinkDB + adb server
limactl start redroid                                          # Linux VM that runs redroid (see below)

npm run dev:api          # tsx watch, reads ../../.env; http://127.0.0.1:3000, /api/health checks every dependency
npm run dev:web          # Vite on :5173, proxies /api (incl. WebSockets) to the API
npm run typecheck        # tsc (api) + vue-tsc (web); there is no linter
npm run db:migrate && npm run db:seed    # seed creates/updates the admin from ADMIN_USERNAME/ADMIN_PASSWORD in .env
cd apps/api && npx drizzle-kit generate --name <name>   # after editing src/db/schema.ts
```

There are no unit tests. All tests are integration scripts against the real infrastructure, which the project forbids replacing with mocks. Run them from `apps/api`, with the API running except for the smoke test:

```bash
npx tsx --env-file=../../.env scripts/smoke-adapters.ts        # adapters only: container→adb→STF→claim→key/tap/paste→teardown
REDROID_IMAGE=cloudphone/redroid:13-mtg-20231025 npx tsx --env-file=../../.env scripts/smoke-adapters.ts
npx tsx --env-file=../../.env scripts/e2e.ts <any.apk>         # 32 checks: lifecycle, remote control, APK, RBAC, isolation
npx tsx --env-file=../../.env scripts/p0-check.ts <any.apk>    # app mgmt, device settings, screenshot, capacity (uses running g13-* instances)
npx tsx --env-file=../../.env scripts/google-check.ts [--restart]   # creates/reuses 2 g13-* GApps instances
```

`e2e.ts` and `google-check.ts` create instances and are refused by the capacity check when the 4 GiB VM is full. `phone-*` instances belong to the user; tests must only touch instances they created.

## Environment facts that are not obvious

- **redroid cannot run in Docker Desktop**: its kernel has no binder. Android runs in the Lima VM `redroid` (`infra/lima/redroid-host.yaml`, Ubuntu arm64, `binder_linux`). The API talks to the VM's Docker through the forwarded socket `~/.lima/redroid/sock/docker.sock` (`DOCKER_HOST` in `.env`). Sourcing `.env` in a shell therefore redirects the `docker` CLI to the VM, not to Docker Desktop.
- Instance adb ports (5555–5604) are published in the VM and forwarded by Lima to the Mac's 127.0.0.1. STF's adb container reaches them as `host.docker.internal:<port>`, which is the device serial (`ADB_DEVICE_HOST`).
- Google's emulator has **no Linux arm64 build**, so the `emulator` engine (`adapters/runtime/emulator.ts`) is code-only and untested. It needs an x86_64 host with `/dev/kvm`.
- The GApps image is built locally from official, signature-verified MindTheGapps: `infra/redroid-gapps/build.sh` (`verify_jar.py`, then `stage.py`, then a Dockerfile). Never use third-party GApps rebuilds.

## Architecture

The API is the only thing browsers talk to. It enforces RBAC and relays STF; STF is never exposed to end users.

- **Two layers per instance, deliberately separate.** Container lifecycle is `AndroidRuntime` (`adapters/runtime/`: a `DockerRuntime` base, `RedroidRuntime`/`EmulatorRuntime` that only define their container spec, and `runtimeFor(engine)` in `index.ts`). Device control is `AdbAdapter` plus `StfAdapter`. `modules/instances/ops.ts` orchestrates both: create container, start, adb connect, boot check *via adb* (engine-agnostic), `applyDeviceSettings`, wait for STF ready, then claim.
- **Profiles** (`src/profiles.ts`) map a profile id to engine, image, `gapps`, `requiresKvm` and `memEstimateMb`. Instances store `profile` and `engine`. `GET /api/profiles` reports availability (image configured, KVM present).
- **All mutations of instances go through BullMQ** (`modules/instances/queue.ts`, one `tasks` row per job): create, start, stop, restart, delete, install-apk, uninstall-app, apply-settings. A failure of a device-only op (`DEVICE_OPS`) must not mark the instance `error`. Routes reject actions on busy statuses.
- **Every instance/task write goes through `modules/instances/repo.ts`**, which publishes on a Redis pub/sub bus (`lib/events.ts`). `/api/events` WebSocket forwards it to browsers, filtered by RBAC. This keeps API and worker splittable later.
- **Monitor** (`modules/monitor/monitor.ts`, every 5 s) reconciles Docker, adb and STF state into the DB and re-attaches dropped adb connections. STF's `ready` flag lags reality, so health is decided by adb and Docker, with STF as advisory. Google health (`modules/google/health.ts`) runs at most every 60 s for GApps profiles.
- **Remote control**: `/api/instances/:id/session` WebSocket. It authenticates with the first message `{type:"auth",token}`, then RBAC, then claims the device in STF. It relays JPEG frames from STF's screen WebSocket (`display.url`, whose **port changes whenever STF recreates the worker**, so resolve it per session) and forwards input via `StfAdapter` using socket.io as the STF service account (which is STF's admin, set via `STF_ADMIN_EMAIL`).
- RBAC (`modules/auth/rbac.ts`): two roles. `admin` sees everything; `user` sees only instances in `instance_grants` and may `view`/`control`/`operate` them. Creating/deleting devices, users/grants, storage settings and library/asset deletion are admin-only (`isAdmin`). The `builtin` user (ADMIN_USERNAME, flagged by the seed) cannot be deleted, disabled, demoted or have its password reset by others; the last enabled admin cannot be removed.

## STF / Android protocol gotchas (all verified; see `docs/01-stf-redroid-compat.md`)

- Touch events are consumed through a `SeqQueue`. They must be wrapped in `gestureStart` … `gestureStop` with consecutive `seq` numbers (mod 100), or they are silently dropped. `StfAdapter` owns the per-channel seq: assign it synchronously before any `await`, and share one in-flight socket connection.
- Per-key injection (`input.type`, fast typing) drops or reorders characters on redroid. Text goes through the `clipboard.paste` transaction. Passwords go through `typeSecure` (one char per 120 ms, never touches the device clipboard).
- Reading the device clipboard via STF fails on Android 10+ (background app denied).
- `adb shell` runs as uid 2000. Reads of app-private data use `su 0` (redroid is userdebug). `sqlite3` crashes on redroid, so the GSF ID is read from GMS `shared_prefs/Checkin.xml`.
- Android 13 `dumpsys activity` uses `ResumedActivity:` (12 used `mResumedActivity`). Launcher icon positions differ between versions (see the `LAYOUT` map in the smoke test).
- Changing system locale restarts zygote (not the container or adbd). Apply the locale **before** other settings, because SettingsProvider writes just before a zygote restart get lost.
- `jp.co.cyberagent.stf*` packages are STF's on-device agents and must never be uninstalled (`isProtectedPackage`).

## Project constraints (from the owner)

- Real tests only; never present mocked results as success.
- Do not implement device-identity spoofing (model/IMEI/fingerprint), Play Integrity bypass, or Google/platform risk-control evasion. Device settings are limited to Android system settings (locale, timezone, device name). Never store Google passwords.
- Downloading system images or GApps, and production/environment changes, need explicit confirmation first.
- Keep the existing stack (KISS/DRY, no extra microservices). STF is used as an independent service through its REST and websocket APIs; don't modify STF source.
- Open work (see `docs/04-architecture-review.md`): per-instance sing-box proxy, groups/tags, templates, CPU limits, scrcpy-based clipboard read, multi-host scheduling for 20–50 devices, compose packaging, STF production auth.
