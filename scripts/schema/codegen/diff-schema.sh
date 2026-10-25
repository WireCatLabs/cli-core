#!/usr/bin/env sh
# Generates schema.ts from ../spec.mjs and diffs it against src/store/sqlite/schema.ts. Comments there are
# written by hand, so they are left out of the diff; any other line means the spec and the code disagree,
# and the script exits 1. Port the difference into schema.ts by hand.
#
#   scripts/schema/codegen/diff-schema.sh [checkout]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=${1:-$(cd "$here/../../.." && pwd)}
out=$(mktemp -d)
trap 'rm -rf "$out" "$repo/src/store/sqlite/.schema.generated.ts"' EXIT
SPEC_DIR="$here/.." node "$here/export-model.mjs" "$out/model.json" >/dev/null
node "$here/gen-schema.mjs" "$out/model.json" "$out/schema.ts" >/dev/null
tmp="$repo/src/store/sqlite/.schema.generated.ts"
cp "$out/schema.ts" "$tmp"
(cd "$repo" && npx biome format --write "$tmp" >/dev/null 2>&1) || true
python3 "$here/comments.py" "$tmp"
(cd "$repo" && npx biome format --write "$tmp" >/dev/null 2>&1) || true
python3 - "$repo/src/store/sqlite/schema.ts" "$out/expanded.ts" <<'PYCODE'
import pathlib, re, sys
source = pathlib.Path(sys.argv[1])
def expand(match):
    module = source.parent / "schema" / (match.group(1) + ".ts")
    return re.sub(r'^(?:import [^\n]+\n)+\n', '', module.read_text(), count=1).rstrip()
text = re.sub(r'^export \{[^}]+\} from "\./schema/([a-z-]+)\.js"$', expand, source.read_text(), flags=re.M)
text = re.sub(r'^import [^\n]+ from [^\n]+\n', '', text, flags=re.M)
pathlib.Path(sys.argv[2]).write_text(text)
PYCODE
differences=$(diff -u "$out/expanded.ts" "$tmp" | grep -E '^[-+][^-+]' | grep -v -E '^[-+]\s*(//|/\*\*|\*)' || true)
[ -z "$differences" ] || { printf '%s\n' "$differences"; echo "spec and schema.ts disagree" >&2; exit 1; }
echo "spec and schema.ts agree"
