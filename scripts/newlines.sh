#!/usr/bin/env bash
set -euo pipefail

options=(--trim-space)
if [[ ${NEWLINES_FIX:-0} == 1 ]]; then
    options+=(--fix)
fi

if jj root >/dev/null 2>&1; then
    jj --ignore-working-copy file list -T 'path ++ "\0"'
else
    git ls-files -z
fi | xargs -0 -r nllint "${options[@]}"
