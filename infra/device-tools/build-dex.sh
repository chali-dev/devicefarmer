#!/usr/bin/env bash
# Builds one app_process helper (.java → .dex) inside a throwaway JDK container.
# Usage: build-dex.sh <dir with Source.java> <Source.java> <out name.dex>
# Needs (official Google SDK packages, sha1-verified against dl.google.com/android/repository/repository2-3.xml, in $SDK_DL):
#   platform-33-ext3_r03.zip  (android.jar)   build-tools_r34-linux.zip  (d8)
set -euo pipefail
SRC_DIR=$(cd "$1" && pwd)
SRC=$2
NAME=$3
SDK_DL=${SDK_DL:?set SDK_DL to the directory holding the two zips}
OUT=${OUT:-$SRC_DIR/out}
mkdir -p "$OUT"
docker run --rm -v "$SRC_DIR:/src:ro" -v "$SDK_DL:/sdk:ro" -v "$OUT:/out" -e SRC="$SRC" -e NAME="$NAME" eclipse-temurin:17-jdk bash -ec '
  mkdir -p plat bt classes
  cd plat && jar xf /sdk/platform-33-ext3_r03.zip android-13/android.jar && cd ..
  cd bt && jar xf /sdk/build-tools_r34-linux.zip android-14/lib/d8.jar && cd ..
  javac -source 8 -target 8 -Xlint:-options -bootclasspath plat/android-13/android.jar -d classes "/src/$SRC"
  mkdir -p /tmp/dex && java -cp bt/android-14/lib/d8.jar com.android.tools.r8.D8 --min-api 30 --lib plat/android-13/android.jar --output /tmp/dex classes/*.class
  cp /tmp/dex/classes.dex "/out/$NAME"
  sha256sum "/out/$NAME"
'
