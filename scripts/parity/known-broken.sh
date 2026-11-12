#!/usr/bin/env bash
# Prints `until=<date>` when any of the given repositories is listed in known-broken.json until a date not yet past,
# else `until=`. For the parity jobs outside the downstream matrix, which downstream-result.sh does not read.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repos=$(printf '%s\n' "$@" | jq -R . | jq -s -c .)
until=$(jq -r --arg t "$(date -u +%F)" --argjson repos "$repos" \
  '[.[] | select((.repo | IN($repos[])) and .until >= $t) | .until] | min // ""' "$here/known-broken.json")
echo "until=$until"
