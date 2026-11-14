#!/usr/bin/env bash
# Builds cloudphone/redroid:<android>-mtg-<date> = official redroid + official MindTheGapps.
# Run on the Android (Linux) host. Downloads must be approved before running.
#   ARCH=arm64|x86_64  (default: arm64)
set -euo pipefail
ARCH=${ARCH:-arm64}
REL=MindTheGapps-13.0.0-${ARCH}-20231025_200931
[ "$ARCH" = x86_64 ] && REL=MindTheGapps-13.0.0-x86_64-20231025_201056
URL=https://github.com/MindTheGapps/13.0.0-${ARCH}/releases/download/${REL}
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-/srv/cloudphone/build/mtg-13-${ARCH}}
mkdir -p "$WORK/dl" "$WORK/ctx"
cd "$WORK/dl"
[ -f "$REL.zip" ] || curl -fSL -o "$REL.zip" "$URL/$REL.zip"
[ -f release.x509.pem ] || curl -fSL -o release.x509.pem "$URL/release.x509.pem"
python3 -I "$HERE/verify_jar.py" "$REL.zip" release.x509.pem          # abort unless signature + all digests verify
python3 -I "$HERE/stage.py" "$REL.zip" "$WORK/ctx"                       # installer's own layout/permissions
cp "$HERE/Dockerfile" "$WORK/ctx/Dockerfile"
cd "$WORK/ctx"
docker build -t "cloudphone/redroid:13-mtg-20231025" .
