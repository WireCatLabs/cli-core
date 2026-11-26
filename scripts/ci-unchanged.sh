#!/usr/bin/env bash
# Decides whether a pull request may skip the heavy checks: it changes nothing but CHANGELOG.md, the changes/
# fragments and package.json's version (scripts/ci-fingerprint.sh), and with DOCS=true also the Markdown docs, against
# a commit on main that is proven green. bin/release's fold and version pull requests are such, and so are docs-only
# pull requests. Any doubt prints reuse=false.
#
# Proven green: scripts/release-reuse.sh shows its pull request's head green on every required check with the same
# tree, or, when main moved under that pull request and main.yml validated the commit itself, every required
# `validation / ` check has passed on the commit. The second is all a run that reports only `validation / ` checks
# (pr.yml, main.yml) may use, so it applies only with DOCS=true.
#
#   GH_TOKEN GITHUB_REPOSITORY   set by the workflow
#   CAN_REPORT                   true when the workflow's token may write check runs (not a fork, not Dependabot)
#   DOCS                         true to also leave the Markdown docs out of the comparison
# Run in the pull request's merge commit, or in a push to main, checked out with its parent (fetch-depth 2).
set -uo pipefail

out=${GITHUB_OUTPUT:-/dev/stdout}
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
here=$(dirname "$0")
flags=()
what="the changelog and the version"
if [ "${DOCS:-}" = true ]; then
  flags=(--docs)
  what="the changelog, the version and the Markdown docs"
fi

full() {
  echo "reuse=false" >>"$out"
  printf '### Unchanged-code check: full validation\n\nReason: %s\n' "$1" >>"$summary"
  echo "full validation: $1"
  exit 0
}

[ "${CAN_REPORT:-}" = true ] || full "this run's token cannot report checks (a fork or Dependabot)"
base=$(git rev-parse --verify HEAD^1) || full "the checkout has no parent to compare with"
mine=$(bash "$here/ci-fingerprint.sh" "${flags[@]}" HEAD) || full "could not fingerprint this commit"
theirs=$(bash "$here/ci-fingerprint.sh" "${flags[@]}" "$base") || full "could not fingerprint ${base:0:10}"
[ "$mine" = "$theirs" ] ||
  full "changes more than $what against main ${base:0:10} (fingerprint $mine, not $theirs)"

echo "base=$base" >>"$out"
echo "fingerprint=$mine" >>"$out"
decision=$(mktemp)
trap 'rm -f "$decision" "$decision.required" "$decision.runs"' EXIT
COMMIT=$base PULL_REQUEST=true GITHUB_OUTPUT=$decision bash "$here/release-reuse.sh"
if grep -qx "reuse=true" "$decision"; then
  pr=$(sed -n 's/^pr=//p' "$decision")
  echo "reuse=true" >>"$out"
  echo "evidence=whose pull request #$pr passed every required check on that tree" >>"$out"
  exit 0
fi
[ "${DOCS:-}" = true ] || full "main ${base:0:10} is not proven green through its pull request"

export REQUIRED_PREFIX="validation / "
gh api "repos/$GITHUB_REPOSITORY/rules/branches/main" --jq '[.[] | select(.type == "required_status_checks")
  | .parameters.required_status_checks[].context | select(startswith(env.REQUIRED_PREFIX))]' >"$decision.required" ||
  full "could not read the required checks of main"
gh api --paginate "repos/$GITHUB_REPOSITORY/commits/$base/check-runs" \
  --jq '.check_runs[] | select(.app.id == 15368) | {name, status, conclusion}' >"$decision.runs" ||
  full "could not read the check runs of ${base:0:10}"
# validation / version runs only on a pull request, so main.yml skips it.
problems=$(jq -r -n --slurpfile required "$decision.required" --slurpfile runs "$decision.runs" '
  if ($required[0] | length) == 0 then "main requires no validation check" else
  $required[0][] as $name
  | ($runs | map(select(.name == $name))) as $found
  | if ($found | length) == 0 then "\($name): no such check run"
    elif ($found | any(.status != "completed"
                       or (.conclusion != "success" and ($name != "validation / version" or .conclusion != "skipped"))))
    then "\($name): " + ($found | map("\(.status)/\(.conclusion // "-")") | join(", "))
    else empty end end') || full "could not compare the check runs of ${base:0:10}"
rm -f "$decision.required" "$decision.runs"
[ -z "$problems" ] || full "main ${base:0:10} is not proven green: $(echo "$problems" | paste -sd ';' -)"

echo "reuse=true" >>"$out"
echo "evidence=on which main.yml passed every required validation check" >>"$out"
printf '### Evidence for %s: its own validation\n\nEvery required `validation / ` check passed on `%s` itself (main.yml).\n' \
  "${base:0:10}" "$base" >>"$summary"
echo "reusing the validation of ${base:0:10} on main"
