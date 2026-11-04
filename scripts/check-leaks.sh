#!/usr/bin/env bash
set -euo pipefail

if jj root >/dev/null 2>&1; then
    jj --ignore-working-copy file list -T 'path ++ "\0"'
else
    git ls-files -z
fi | xargs -0 -r betterleaks dir --redact --no-banner
