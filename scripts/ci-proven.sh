#!/usr/bin/env bash
# Exits 0 when every check main's ruleset requires that starts with PREFIX has passed on COMMIT itself, from GitHub
# Actions (validation / version may be skipped: it runs only on a pull request and in the merge queue). Otherwise it
# prints what is missing and exits 1.
#
#   GH_TOKEN GITHUB_REPOSITORY   set by the workflow
#   scripts/ci-proven.sh <commit> [prefix]   (default prefix "validation / ")
set -uo pipefail

commit=$1
export REQUIRED_PREFIX=${2:-validation / }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

gh api "repos/$GITHUB_REPOSITORY/rules/branches/main" --jq '[.[] | select(.type == "required_status_checks")
  | .parameters.required_status_checks[].context | select(startswith(env.REQUIRED_PREFIX))]' >"$work/required" ||
  { echo "could not read the required checks of main"; exit 1; }
gh api --paginate "repos/$GITHUB_REPOSITORY/commits/$commit/check-runs" \
  --jq '.check_runs[] | select(.app.id == 15368) | {name, status, conclusion}' >"$work/runs" ||
  { echo "could not read the check runs of ${commit:0:10}"; exit 1; }
problems=$(jq -r -n --slurpfile required "$work/required" --slurpfile runs "$work/runs" '
  if ($required[0] | length) == 0 then "main requires no such check" else
  $required[0][] as $name
  | ($runs | map(select(.name == $name))) as $found
  | if ($found | length) == 0 then "\($name): no such check run"
    elif ($found | any(.status != "completed"
                       or (.conclusion != "success" and ($name != "validation / version" or .conclusion != "skipped"))))
    then "\($name): " + ($found | map("\(.status)/\(.conclusion // "-")") | join(", "))
    else empty end end') || { echo "could not compare the check runs of ${commit:0:10}"; exit 1; }
[ -z "$problems" ] || { echo "$problems" | paste -sd ';' -; exit 1; }
