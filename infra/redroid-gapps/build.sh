#!/usr/bin/env bash
# Builds cloudphone/redroid:<android>-mtg-<date> = official redroid + official MindTheGapps.
# Run on the Android (Linux) host. Downloads must be approved before running.
#   ANDROID=13|16 (default 13)   ARCH=arm64|x86_64 (default arm64)
set -euo pipefail
ANDROID=${ANDROID:-13}
ARCH=${ARCH:-arm64}
case "$ANDROID-$ARCH" in
  13-arm64)  REL=MindTheGapps-13.0.0-arm64-20231025_200931;  BASE=redroid/redroid:13.0.0_64only-latest ;;
  13-x86_64) REL=MindTheGapps-13.0.0-x86_64-20231025_201056; BASE=redroid/redroid:13.0.0_64only-latest ;;
  16-arm64)  REL=MindTheGapps-16.0.0-arm64-20261023_034858;  BASE=redroid/redroid:16.0.0_64only-latest ;;
  *) echo "unsupported $ANDROID-$ARCH (add the release name here)"; exit 1 ;;
esac
TAG=cloudphone/redroid:${ANDROID}-mtg-$(echo "$REL" | grep -oE '[0-9]{8}' | head -1)
URL=https://github.com/MindTheGapps/${ANDROID}.0.0-${ARCH}/releases/download/${REL}
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-/srv/cloudphone/build/mtg-${ANDROID}-${ARCH}}
mkdir -p "$WORK/dl" "$WORK/ctx"
cd "$WORK/dl"
[ -f "$REL.zip" ] || curl -fSL -o "$REL.zip" "$URL/$REL.zip"
[ -f release.x509.pem ] || curl -fSL -o release.x509.pem "$URL/release.x509.pem"
# 13 packages are JAR-signed, 16 packages carry an OTA whole-file signature; either must verify.
python3 -I "$HERE/verify_jar.py" "$REL.zip" release.x509.pem 2>/dev/null \
  || python3 -I "$HERE/verify_ota.py" "$REL.zip" release.x509.pem
python3 -I "$HERE/stage.py" "$REL.zip" "$WORK/ctx"                       # installer's own layout/permissions
sed -e "s#^FROM .*#FROM ${BASE}#" -e "s#MindTheGapps-[^\"]*#${REL}#" "$HERE/Dockerfile" > "$WORK/ctx/Dockerfile"
cd "$WORK/ctx"
docker build -t "$TAG" .
echo "built $TAG"
