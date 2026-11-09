#!/usr/bin/env sh
# Fails a pull request that edits CHANGELOG.md unless bin/release opened it (its branches are all release/*).
# A release pull request that conflicts with another edit to CHANGELOG.md never merges, and bin/release waits on it.
#
#   scripts/changelog-release-only.sh <base sha> <head sha> <head branch>
set -eu

base=$1 head=$2 branch=$3
case "$branch" in release/*) exit 0 ;; esac
# Three dots: main's own releases edit CHANGELOG.md after the branch point, and are not this pull request's edit.
git diff --quiet "$base...$head" -- CHANGELOG.md && exit 0
echo "::error file=CHANGELOG.md::This pull request edits CHANGELOG.md: add changes/<branch>.md (lower case, / as -) with ### headings; only bin/release edits CHANGELOG.md"
exit 1
