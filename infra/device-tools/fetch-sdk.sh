#!/usr/bin/env bash
# Downloads the two official Google SDK packages build-dex.sh needs into $SDK_DL and verifies each
# against the sha1 Google publishes in https://dl.google.com/android/repository/repository2-3.xml
# (checked 2026-11-17). Bump name and sha1 together.
set -euo pipefail
SDK_DL=${SDK_DL:?set SDK_DL to the download directory}
BASE=https://dl.google.com/android/repository
PKGS=(
  "platform-33-ext3_r03.zip 394bc86d8d3452aa4d419b67743025a6fb2cd9d0"
  "build-tools_r34-linux.zip d6d58e0c6925a9e4d9a541e84cd1f405c2f9d2a9"
)
if command -v sha1sum >/dev/null; then SUM=(sha1sum); else SUM=(shasum -a 1); fi
mkdir -p "$SDK_DL"
for p in "${PKGS[@]}"; do
  read -r name sha1 <<<"$p"
  dest="$SDK_DL/$name"
  if [ -f "$dest" ] && echo "$sha1  $dest" | "${SUM[@]}" -c - >/dev/null 2>&1; then echo "already present: $name"; continue; fi
  tmp=$(mktemp "$SDK_DL/.dl.XXXXXX")
  curl -fsSL -o "$tmp" "$BASE/$name"
  echo "$sha1  $tmp" | "${SUM[@]}" -c - >/dev/null || { rm -f "$tmp"; echo "sha1 mismatch for $name" >&2; exit 1; }
  mv "$tmp" "$dest"
  echo "ok: $name ($sha1)"
done
