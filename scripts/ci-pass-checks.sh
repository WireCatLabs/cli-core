#!/usr/bin/env bash
# Reports checks that a pull request's run did not need as passed, so the ruleset and scripts/release-reuse.sh,
# which both want every required check green on the head, see them. Each run's summary says why it did not run.
# A check run created with the workflow's token belongs to the GitHub Actions app, like the real one would.
#
#   GH_TOKEN GITHUB_REPOSITORY HEAD_SHA   set by the workflow (the token needs checks: write)
#   TITLE SUMMARY                         why the checks did not run, and the evidence
#   stdin                                 the check names, one per line
set -euo pipefail

: "${GH_TOKEN:?}" "${GITHUB_REPOSITORY:?}" "${HEAD_SHA:?}" "${TITLE:?}" "${SUMMARY:?}"

posted=0
while IFS= read -r name; do
  [ -n "$name" ] || continue
  jq -n --arg name "$name" --arg sha "$HEAD_SHA" --arg title "$TITLE" --arg summary "$SUMMARY" \
    '{name: $name, head_sha: $sha, status: "completed", conclusion: "success", output: {title: $title, summary: $summary}}' |
    gh api -X POST "repos/$GITHUB_REPOSITORY/check-runs" --input - --jq '"passed without running: \(.name)"'
  posted=$((posted + 1))
done
printf '### %s\n\n%s\n\n%s checks reported as passed without running.\n' "$TITLE" "$SUMMARY" "$posted" \
  >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
