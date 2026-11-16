# scrcpy-server (高速画面)

The API's `scrcpy` screen source (`apps/api/src/adapters/scrcpy.ts`) runs the **official** scrcpy server on the
device. Only the server is used; the desktop client is not needed.

| | |
|---|---|
| Project | https://github.com/Genymobile/scrcpy |
| Version | **v5.0.1** (latest stable, released 2026-10-08) |
| File | `scrcpy-server-v5.0.1` (release asset) |
| SHA-256 | `764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536` |
| License | Apache License 2.0 |

The checksum is the one published by the project for this release in `doc/build.md` at tag `v5.0.1`. The release's
`SHA256SUMS.txt` and the GitHub asset digest give the same value. The release notes themselves no longer list
checksums.

```bash
infra/device-tools/scrcpy/fetch.sh   # downloads into out/ (gitignored) and verifies the SHA-256
```

`SCRCPY_SERVER_PATH` (apps/api config) defaults to `../../infra/device-tools/scrcpy/out/scrcpy-server-v5.0.1`. The
server checks that the client passes its exact version, so to upgrade, change `VERSION`/`SHA256` in `fetch.sh`,
`SCRCPY_VERSION` in `adapters/scrcpy.ts` and the config default together, and recheck the wire format against that
version's `DesktopConnection`, `Streamer`, `ControlMessageReader` and `DeviceMessageWriter`. On the device the
server is pushed once to `/data/local/tmp/scrcpy-server-v<version>.jar` (with `cleanup=false`, because the default
cleanup deletes the jar at start).

## Notices

scrcpy is Copyright (C) 2018 Genymobile and Copyright (C) 2018-2026 Romain Vimont, licensed under the Apache
License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). The binary is fetched from the release and used unmodified; it is not committed.

The browser-side approach (H.264 relayed over a WebSocket and decoded in the browser) follows ws-scrcpy
(https://github.com/NetrisTV/ws-scrcpy, Copyright (C) 2021 by Netris, JSC., MIT License). No ws-scrcpy code or on-device
server is used.
