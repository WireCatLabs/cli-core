#!/usr/bin/env bash
# Prints the git tree of <rev> without CHANGELOG.md and the changes/ fragments, and with package.json's "version" set
# to 0.0.0: two commits share it only when everything but the changelog and the version is byte for byte the same.
# With --docs it also leaves out the Markdown under docs/ and at the top level: no build reads it, and pr.yml's fast job
# runs the checks and tests that compare it with the code. README.md ships in the package but nothing reads it.
# skills/ and docs/search/recipes.json ship and the code reads them, so they stay in.
#
#   scripts/ci-fingerprint.sh [--docs] [rev]   (default HEAD)
set -euo pipefail

docs=false
[ "${1:-}" != --docs ] || { docs=true; shift; }
rev=${1:-HEAD}
index=$(mktemp)
trap 'rm -f "$index"' EXIT
export GIT_INDEX_FILE=$index

git read-tree "$rev"
git update-index --force-remove CHANGELOG.md
git ls-files -z -- changes | git update-index -z --force-remove --stdin
if [ "$docs" = true ]; then
  git ls-files -z -- ':(glob)docs/**/*.md' ':(glob)*.md' | git update-index -z --force-remove --stdin
fi
# Only the top-level field, found by its two-space indent; anything else in the file stays as it is.
blob=$(git show "$rev:package.json" | node -e '
  const text = require("fs").readFileSync(0, "utf8")
  const line = /^  "version": "[^"\n]*"/gm
  const found = text.match(line)?.length ?? 0
  if (found !== 1) {
    console.error(`package.json has ${found} top-level "version" lines, not one`)
    process.exit(1)
  }
  process.stdout.write(text.replace(line, `  "version": "0.0.0"`))
' | git hash-object --stdin)
git update-index --cacheinfo "100644,$blob,package.json"
# The blob above is never written to the object store: the fingerprint is the tree id only.
git write-tree --missing-ok
