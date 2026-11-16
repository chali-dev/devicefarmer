#!/usr/bin/env bash
# Downloads the official scrcpy-server (Genymobile/scrcpy release, Apache-2.0) into out/
# and verifies it against the pinned SHA-256. Bump VERSION and SHA256 together.
set -euo pipefail
VERSION=5.0.1
SHA256=764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${OUT:-$HERE/out}
DEST="$OUT/scrcpy-server-v$VERSION"
mkdir -p "$OUT"
if [ -f "$DEST" ] && echo "$SHA256  $DEST" | shasum -a 256 -c - >/dev/null 2>&1; then
  echo "already present: $DEST"; exit 0
fi
TMP=$(mktemp "$OUT/.dl.XXXXXX")
trap 'rm -f "$TMP"' EXIT
curl -fsSL -o "$TMP" "https://github.com/Genymobile/scrcpy/releases/download/v$VERSION/scrcpy-server-v$VERSION"
echo "$SHA256  $TMP" | shasum -a 256 -c - >/dev/null || { echo "SHA-256 mismatch for scrcpy-server v$VERSION" >&2; exit 1; }
mv "$TMP" "$DEST"
trap - EXIT
echo "ok: $DEST ($SHA256)"
