#!/usr/bin/env bash
# Builds out/cprelay.dex from CpRelay.java (see ../build-dex.sh for the SDK_DL requirement).
exec "$(dirname "$0")/../build-dex.sh" "$(dirname "$0")" CpRelay.java cprelay.dex
