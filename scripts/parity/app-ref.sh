#!/usr/bin/env bash
# Prints `ref=<ref>` of <app>-cli (or [repo], where the repository is named otherwise) for Parity to build. APP_REF, when set, names it outright and must exist: a
# release whose apps adopt it on a branch is validated against that branch (bin/release --app-ref). Otherwise,
# on a pull request whose branch also exists in the app, that branch: a change the app must adopt goes green
# against the app's adoption branch, which merges after the release. Otherwise the app's main.
set -euo pipefail

app=$1
repo=${2:-$app-cli}
explicit=${APP_REF:-}
branch=${explicit:-${PR_BRANCH:-}}
ref=main

if [ -n "$branch" ] && [ "$branch" != main ]; then
  status=0
  git ls-remote --exit-code --heads "https://github.com/WireCatLabs/$repo.git" "refs/heads/$branch" \
    >/dev/null || status=$?
  case $status in
    0) ref=$branch ;;
    2)
      if [ -n "$explicit" ]; then
        echo "::error title=$repo::WireCatLabs/$repo has no branch $branch" >&2
        exit 1
      fi
      ;;
    *) echo "::error title=$repo::cannot list the branches of WireCatLabs/$repo" >&2; exit 1 ;;
  esac
fi

echo "ref=$ref"
