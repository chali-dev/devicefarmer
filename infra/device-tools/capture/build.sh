#!/usr/bin/env bash
# Builds cpcapture.dex from CpCapture.java inside a throwaway JDK container.
# Needs (official Google SDK packages, sha1-verified, in $SDK_DL):
#   platform-33-ext3_r03.zip  (android.jar)   build-tools_r34-linux.zip  (d8)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SDK_DL=${SDK_DL:?set SDK_DL to the directory holding the two zips}
OUT=${OUT:-$HERE/out}
mkdir -p "$OUT"
docker run --rm -v "$HERE:/src:ro" -v "$SDK_DL:/sdk:ro" -v "$OUT:/out" eclipse-temurin:17-jdk bash -ec '
  mkdir -p plat bt classes
  cd plat && jar xf /sdk/platform-33-ext3_r03.zip android-13/android.jar && cd ..
  cd bt && jar xf /sdk/build-tools_r34-linux.zip android-14/lib/d8.jar && cd ..
  javac -source 8 -target 8 -Xlint:-options -bootclasspath plat/android-13/android.jar -d classes /src/CpCapture.java
  mkdir -p /tmp/dex && java -cp bt/android-14/lib/d8.jar com.android.tools.r8.D8 --min-api 30 --lib plat/android-13/android.jar --output /tmp/dex classes/*.class
  cp /tmp/dex/classes.dex /out/cpcapture.dex
  sha256sum /out/cpcapture.dex
'
