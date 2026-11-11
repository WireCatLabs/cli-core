#!/usr/bin/env bash
# Prints `--add-host` flags for `docker run` that pin the Ubuntu mirrors to addresses found on the runner, or from
# public resolvers when the runner cannot resolve them (Canonical's DNS outage of 2026-11-11,
# actions/runner-images#15296). A container's own lookups failed then even with host networking. apt still checks
# every package's signature, so an address from here cannot slip in a package.
set -u
for host in archive.ubuntu.com security.ubuntu.com; do
  ip=$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR == 1 { print $1 }')
  if [ -z "$ip" ]; then
    for resolver in 1.1.1.1 8.8.8.8 9.9.9.9; do
      ip=$(dig +short +time=3 +tries=2 "$host" A "@$resolver" 2>/dev/null | grep -E '^[0-9.]+$' | head -1)
      [ -n "$ip" ] && break
    done
    [ -n "$ip" ] && echo "::warning::$host did not resolve on the runner, using $ip from $resolver" >&2
  fi
  if [ -n "$ip" ]; then
    printf -- '--add-host=%s:%s ' "$host" "$ip"
  else
    echo "::warning::$host did not resolve on the runner or on public resolvers" >&2
  fi
done
