#!/usr/bin/env bash
# Builds one app_process helper (.java → .dex) inside a throwaway JDK container (see compile-dex.sh).
# Usage: build-dex.sh <dir with Source.java> <Source.java> <out name.dex>
# Needs (official Google SDK packages, sha1-verified against dl.google.com/android/repository/repository2-3.xml, in $SDK_DL;
# fetch-sdk.sh downloads and verifies them):
#   platform-33-ext3_r03.zip  (android.jar)   build-tools_r34-linux.zip  (d8)
set -euo pipefail
SRC_DIR=$(cd "$1" && pwd)
SRC=$2
NAME=$3
SDK_DL=${SDK_DL:?set SDK_DL to the directory holding the two zips}
OUT=${OUT:-$SRC_DIR/out}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
docker run --rm -v "$SRC_DIR:/src:ro" -v "$SDK_DL:/sdk:ro" -v "$OUT:/out" -v "$HERE/compile-dex.sh:/compile-dex.sh:ro" \
  eclipse-temurin:17-jdk bash /compile-dex.sh /src "$SRC" "$NAME" /sdk /out
