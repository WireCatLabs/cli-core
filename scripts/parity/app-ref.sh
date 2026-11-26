#!/usr/bin/env bash
# Prints `ref=<ref>` of <app>-cli (or [repo], where the repository is named otherwise) for Parity to build. APP_REF,
# when set, names it outright: a release whose apps adopt it on a branch is validated against that branch
# (bin/release --app-ref); an app without that branch has nothing to adopt and builds its main. Otherwise, on a pull
# request whose branch is also an open pull request in the app, that branch: a change the app must adopt goes green
# against the app's adoption pull request, which merges after the release. A branch alone, with no pull request, no
# longer steers parity. Otherwise the app's main.
set -euo pipefail

app=$1
repo=${2:-$app-cli}
explicit=${APP_REF:-}
pr_branch=${PR_BRANCH:-}
# In the merge queue (refs/heads/gh-readonly-queue/main/pr-<n>-<sha>) the branch is the queued pull request's.
if [ -z "$pr_branch" ] && [[ ${QUEUE_REF:-} =~ /pr-([0-9]+)-[0-9a-f]+$ ]]; then
  pr_branch=$(gh api "repos/$GITHUB_REPOSITORY/pulls/${BASH_REMATCH[1]}" --jq .head.ref) || {
    echo "::error title=$repo::cannot read the branch of queued pull request #${BASH_REMATCH[1]}" >&2
    exit 1
  }
fi
branch=${explicit:-$pr_branch}
ref=main

if [ -n "$branch" ] && [ "$branch" != main ]; then
  status=0
  git ls-remote --exit-code --heads "https://github.com/WireCatLabs/$repo.git" "refs/heads/$branch" \
    >/dev/null || status=$?
  case $status in
    0)
      if [ -n "$explicit" ]; then
        ref=$branch
      else
        open=$(gh api "repos/WireCatLabs/$repo/pulls?head=WireCatLabs:$branch&state=open" --jq length \
          2>/dev/null) || {
          echo "::error title=$repo::cannot list the pull requests of WireCatLabs/$repo" >&2
          exit 1
        }
        if [ "$open" -gt 0 ]; then
          ref=$branch
        else
          echo "::notice title=$repo::WireCatLabs/$repo has a branch $branch but no open pull request from it;" \
            "building main" >&2
        fi
      fi
      ;;
    2) [ -z "$explicit" ] || echo "::notice title=$repo::WireCatLabs/$repo has no branch $branch; building main" >&2 ;;
    *) echo "::error title=$repo::cannot list the branches of WireCatLabs/$repo" >&2; exit 1 ;;
  esac
fi

echo "ref=$ref"
