#!/usr/bin/env bash
# Prints `ref=<ref>` of <app>-cli for Parity to build. APP_REF, when set, names it outright and must exist: a
# release whose apps adopt it on a branch is validated against that branch (bin/release --app-ref). Otherwise,
# on a pull request whose branch also exists in the app, that branch: a change the app must adopt goes green
# against the app's adoption branch, which merges after the release. Otherwise the app's main.
set -euo pipefail

app=$1
explicit=${APP_REF:-}
branch=${explicit:-${PR_BRANCH:-}}
ref=main

if [ -n "$branch" ] && [ "$branch" != main ]; then
  status=0
  git ls-remote --exit-code --heads "https://github.com/WireCatLabs/$app-cli.git" "refs/heads/$branch" \
    >/dev/null || status=$?
  case $status in
    0) ref=$branch ;;
    2)
      if [ -n "$explicit" ]; then
        echo "::error title=$app-cli::WireCatLabs/$app-cli has no branch $branch" >&2
        exit 1
      fi
      ;;
    *) echo "::error title=$app-cli::cannot list the branches of WireCatLabs/$app-cli" >&2; exit 1 ;;
  esac
fi

echo "ref=$ref"
