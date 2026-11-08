#!/usr/bin/env bash
# Builds a CLI's checkout against this checkout of cli-core, packed into <tarball>, instead of the
# release it pins: parity must judge what this change does to the apps, not what the last release did.
set -euo pipefail

app=$1
dir=$2
tarball=$(realpath "$3")
ref=$4
shared=$(cd "$(dirname "$0")/../.." && pwd)

cd "$dir"
echo "::notice title=$app-cli::Parity builds $app-cli at $ref ($(git rev-parse --short HEAD))"
pnpm install --frozen-lockfile

# The packed library's @wirecat peers (cli-base) must be at least the versions it was built against, or it loads
# against the app's older pin and fails on exports that do not exist there yet. An app already on a newer one keeps
# it: lowering it lints the app against rules it has moved past.
peers=$(node -e '
  const { existsSync, readFileSync } = require("node:fs")
  const pkg = require(process.argv[1])
  const parts = (version) => version.split("-")[0].split(".").map(Number)
  const older = (a, b) => {
    const [x, y] = [parts(a), parts(b)]
    const i = x.findIndex((n, j) => n !== y[j])
    return i !== -1 && x[i] < y[i]
  }
  const installed = (name) => {
    const file = `node_modules/${name}/package.json`
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).version : undefined
  }
  console.log(Object.keys(pkg.peerDependencies ?? {})
    .filter((name) => name.startsWith("@wirecat/"))
    .filter((name) => {
      const own = installed(name)
      return own === undefined || older(own, pkg.devDependencies[name])
    })
    .map((name) => `${name}@${pkg.devDependencies[name]}`)
    .join(" "))
' "$shared/package.json")
# Under the name the app imports: until each app switches, that is still the old @wirecat/cli-messaging.
name=@wirecat/cli-core
grep -q '"@wirecat/cli-core"' package.json || name=@wirecat/cli-messaging
# shellcheck disable=SC2086
pnpm add "$name@file:$tarball" $peers

pinned=$(pnpm list "$name" --depth Infinity --parseable | grep "/$name\$" | grep -v '@file+' || true)
if [ -n "$pinned" ]; then
  echo "::error title=$app-cli::$app-cli still resolves a released $name besides this checkout: $pinned"
  exit 1
fi

if ! pnpm build; then
  echo "::error title=$app-cli does not build against this cli-core::$app-cli $ref fails to compile with" \
    "this checkout of @wirecat/cli-core ($peers). The compiler errors are above;" \
    "$app-cli needs adoption work before this change can merge."
  exit 1
fi
