#!/usr/bin/env bash
# Sums parity.yml's downstream matrix into one check. A CLI that no longer builds, typechecks, starts or passes its
# tests is broken and fails the check, unless the pull request carries the label $LABEL: then it passes and the
# summary names the broken CLIs. A failed `pnpm generate` breaks too: the tests read what it writes. Command lint and
# docs failures only warn. A CLI listed in known-broken.json until a
# date not yet past only warns too: a break made on purpose stays known on main and at release, where no label is
# read, until the CLI adopts the change.
#
#   outcomes dir   one <repo>.json per matrix leg, written by its "Record the outcome" step
#   RESULT         needs.downstream.result
#   PR LABEL GH_TOKEN GITHUB_REPOSITORY   PR is empty outside a pull request: no label can apply
set -uo pipefail

dir=$1
here=$(cd "$(dirname "$0")" && pwd)
summary=${GITHUB_STEP_SUMMARY:-/dev/stdout}
LABEL=${LABEL:-breaks-downstream}

broken=() warned=() known=()
today=$(date -u +%F)
known_until() { jq -r --arg r "$1" --arg t "$today" '.[] | select(.repo == $r and .until >= $t) | .until' \
  "$here/known-broken.json" | head -n1; }
{
  echo "### Downstream CLIs against this cli-core"
  echo
  echo "| CLI | ref | build | typecheck | start | tests | command lint | docs |"
  echo "| --- | --- | --- | --- | --- | --- | --- | --- |"
} >>"$summary"
for repo in $(jq -r '.[].repo' "$here/downstream.json"); do
  file="$dir/$repo.json"
  if [ ! -f "$file" ]; then
    echo "| $repo | | no result | | | | | |" >>"$summary"
    broken+=("$repo (no result)")
    continue
  fi
  get() { jq -r --arg k "$1" '.[$k] // ""' "$file"; }
  jq -r '"| \(.repo) | \(.ref) | \(.build) | \(.typecheck) | \(.start) | \(.tests // "" | if . == "" then "not run" else . end) | \(.lint) | \(.docs) |"' \
    "$file" >>"$summary"
  failed=()
  for step in build typecheck start; do [ "$(get "$step")" = success ] || failed+=("$step"); done
  [ "$(get generate)" != failure ] || failed+=(generate)
  [ "$(get tests)" != failure ] || failed+=(tests)
  until=$(known_until "$repo")
  if [ ${#failed[@]} -eq 0 ]; then
    [ -z "$until" ] || echo "::warning title=$repo::$repo passes; remove it from scripts/parity/known-broken.json"
  elif [ -n "$until" ]; then
    known+=("$repo (${failed[*]})")
  else
    broken+=("$repo (${failed[*]})")
  fi
  soft=()
  for step in lint docs; do [ "$(get "$step")" = success ] || soft+=("$step"); done
  [ ${#soft[@]} -eq 0 ] || warned+=("$repo (${soft[*]})")
done
echo >>"$summary"

if [ ${#warned[@]} -gt 0 ]; then
  printf -v list '%s, ' "${warned[@]}"
  echo "::warning title=downstream::command lint or docs fail in ${list%, } — cleanup the CLI owes, not a break"
  echo "Warnings (do not block): ${list%, }" >>"$summary"
fi

if [ ${#known[@]} -gt 0 ]; then
  printf -v list '%s, ' "${known[@]}"
  echo "::notice title=downstream broken on purpose::listed in scripts/parity/known-broken.json: ${list%, }"
  echo "Known breaks (scripts/parity/known-broken.json): ${list%, }" >>"$summary"
fi

if [ ${#broken[@]} -eq 0 ]; then
  if [ "${RESULT:-}" != success ] && [ ${#known[@]} -eq 0 ]; then
    echo "::error::the downstream matrix ended as '${RESULT:-}', and no recorded step says why: see its jobs"
    exit 1
  fi
  [ ${#known[@]} -gt 0 ] || echo "No CLI breaks against this cli-core." >>"$summary"
  exit 0
fi

printf -v list '%s, ' "${broken[@]}"
list=${list%, }
labelled=false
if [ -n "${PR:-}" ]; then
  labels=$(gh api "repos/$GITHUB_REPOSITORY/issues/$PR/labels" --jq '.[].name') ||
    echo "::error::could not read the labels of #$PR"
  grep -qxF "$LABEL" <<<"${labels:-}" && labelled=true
fi
if [ "$labelled" = true ]; then
  echo "::notice title=downstream broken on purpose::#$PR carries '$LABEL'; these CLIs break: $list"
  printf '**Broken on purpose** (`%s`): %s. The pull request body says why; each CLI adopts the change before it bumps.\n' \
    "$LABEL" "$list" >>"$summary"
  exit 0
fi
echo "::error title=downstream::these CLIs break against this cli-core: $list. Fix it, or, if the break is on purpose," \
  "list them in scripts/parity/known-broken.json with this pull request and a date to adopt by," \
  "and say why in its body"
printf '**Broken**: %s.\n' "$list" >>"$summary"
exit 1
