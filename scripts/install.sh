#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ ! -d node_modules/jsonc-parser ]]; then
  npm ci --omit=dev --ignore-scripts
fi
exec node scripts/install.mjs "$@"
