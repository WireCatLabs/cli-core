#!/usr/bin/env bash
# Sums parity.yml's downstream matrix into one check. A CLI that no longer builds, typechecks, starts or passes its
# tests is broken and fails the check, unless the pull request carries the label $LABEL: then it passes and the
# summary names the broken CLIs. Command lint and docs failures only warn.
#
#   outcomes dir   one <repo>.json per matrix leg, written by its "Record the outcome" step
#   RESULT         needs.downstream.result
#   PR LABEL GH_TOKEN GITHUB_REPOSITORY   PR is empty outside a pull request: no label can apply
set -uo pipefail

dir=$1
here=$(cd "$(dirname "$0")" && pwd)
summary=${GITHUB_STEP_SUMMARY:-/dev/stdout}
LABEL=${LABEL:-breaks-downstream}

broken=() warned=()
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
  [ "$(get tests)" != failure ] || failed+=(tests)
  [ ${#failed[@]} -eq 0 ] || broken+=("$repo (${failed[*]})")
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

if [ ${#broken[@]} -eq 0 ]; then
  if [ "${RESULT:-}" != success ]; then
    echo "::error::the downstream matrix ended as '${RESULT:-}', and no recorded step says why: see its jobs"
    exit 1
  fi
  echo "No CLI breaks against this cli-core." >>"$summary"
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
  "add the label '$LABEL', say why in the pull request body and re-run this job"
printf '**Broken**: %s.\n' "$list" >>"$summary"
exit 1
