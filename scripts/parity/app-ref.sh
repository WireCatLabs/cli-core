#!/usr/bin/env bash
# Prints `ref=<ref>` of <app>-cli for Parity to build. On a pull request whose branch also exists in the app,
# that branch: a change the app must adopt goes green against the app's adoption branch, which merges after
# the release. Otherwise, and on release and monthly runs, the app's main.
set -euo pipefail

app=$1
branch=${PR_BRANCH:-}
ref=main

if [ -n "$branch" ]; then
  status=0
  git ls-remote --exit-code --heads "https://github.com/WireCatLabs/$app-cli.git" "refs/heads/$branch" \
    >/dev/null || status=$?
  case $status in
    0) ref=$branch ;;
    2) ;;
    *) echo "::error title=$app-cli::cannot list the branches of WireCatLabs/$app-cli" >&2; exit 1 ;;
  esac
fi

echo "ref=$ref"
