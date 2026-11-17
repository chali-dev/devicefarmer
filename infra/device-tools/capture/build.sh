#!/usr/bin/env bash
# Builds out/cpcapture.dex from CpCapture.java (see ../build-dex.sh for the SDK_DL requirement).
exec "$(dirname "$0")/../build-dex.sh" "$(dirname "$0")" CpCapture.java cpcapture.dex
