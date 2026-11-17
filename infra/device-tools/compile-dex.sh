#!/usr/bin/env bash
# Compiles one app_process helper (.java → .dex). Runs inside a JDK 17 (jar, javac, java on PATH):
# the throwaway container of build-dex.sh, or the dex stage of deploy/docker/api.Dockerfile.
# Usage: compile-dex.sh <src dir> <Source.java> <out name.dex> <SDK_DL dir> <out dir>
set -euo pipefail
SRC_DIR=$1 SRC=$2 NAME=$3 SDK=$4 OUT=$5
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
mkdir -p plat bt classes dex
(cd plat && jar xf "$SDK/platform-33-ext3_r03.zip" android-13/android.jar)
(cd bt && jar xf "$SDK/build-tools_r34-linux.zip" android-14/lib/d8.jar)
javac -source 8 -target 8 -Xlint:-options -bootclasspath plat/android-13/android.jar -d classes "$SRC_DIR/$SRC"
java -cp bt/android-14/lib/d8.jar com.android.tools.r8.D8 --min-api 30 --lib plat/android-13/android.jar --output dex classes/*.class
mkdir -p "$OUT"
cp dex/classes.dex "$OUT/$NAME"
sha256sum "$OUT/$NAME"
