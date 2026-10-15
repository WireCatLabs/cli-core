# Handoff — tasks without duplicates, then the tg/max release (2026-10-15)

The trail, optional, grep by id: cli-private `journal/2026-10-11-channel-report.md` (TASK-594, ASK-246..251,
NEED-1087..1119).

## 1. What this is

cli-core is the shared library behind tg, max, memo, zoom and drive. The owner approved a tasks design
([tasks-plan.md](tasks-plan.md)): tasks like beads, many per chat, no duplicates — a check when a task is created,
a review list the agent works through after `sync`, merges that can be undone. Build steps 2, 3, 4 and 7 are on
main; step 5 (the duplicate check) is being built; after it, cli-core is released together with
cli-core#1121 (`search mail` leaves tg and max), and tg and max move onto it. The owner is away and wants the
work carried on without questions, inside the rules below.

## 2. Orient in one call

```sh
{ cd ~/Projects/AI/cli-messaging && git fetch -q && git log --oneline -5 origin/main
  git show origin/main:docs/dev/tasks-plan.md | sed -n '245,266p'
  git show origin/main:docs/dev/COORDINATION.md | sed -n '7p'
  for r in cli-core tg-cli max-cli cli-docs; do gh pr list -R WireCatLabs/$r --head feat/source-search-own \
    --json number,mergeable,headRefOid --jq ".[] | \"$r #\(.number) \(.mergeable) \(.headRefOid[0:8])\""; done
  gh pr list -R WireCatLabs/cli-core --head feat/task-duplicates --state all --json number,state,headRefOid
  gh issue view 849 -R WireCatLabs/cli-core --json comments --jq '.comments[-4:][] | .createdAt + " " + .body[0:300]'
  gh run list -R WireCatLabs/cli-core --workflow release.yml -L 1 --json status,conclusion,headSha
  for a in cli-core tg-cli max-cli cli-memo; do echo "$a $(npm view @wirecat/$a version)"; done
  sed -n '1,60p' ~/.ccs/instances/my/projects/-home-leemour-Projects-AI-cli-meetings/memory/cli-messaging-writers.md
} > ~/.cache/tasks-orient.txt 2>&1
```

Then read `~/.cache/tasks-orient.txt`. It shows: what landed on main last; the build order with what is left; the
next free store migration; the four `search mail` PRs and whether they still merge; the step 5 PR, if opened;
the last coordination comments; whether a release is running; the published versions; and the merge rules
learned the hard way.

## 3. Read in this order (only if the orient output is not enough)

1. `docs/dev/tasks-plan.md:117-230` — what the duplicate check must do (bands, who decides, the review list).
2. `docs/dev/COORDINATION.md` → "Releases" — how a cli-core release is announced and started.
3. `~/.ccs/instances/my/projects/-home-leemour-Projects-AI-cli-meetings/memory/consumer-release-flow.md` — how
   tg and max are released (version bump by PR, max needs an owner-signed report).
4. The step 5 PR body, once it exists — what was built and its checks.

## 4. Do

1. **Merge step 5.** A background agent builds it on `feat/task-duplicates` (worktree
   `~/Projects/AI/cli-core-wt-task-duplicates`, migration 15 `task_pairs`). When its PR is up: read the diff,
   check that "nothing merges on a score" and "merge never deletes" hold, then merge with the guard in § 5.1.
   Check: the PR's CI green and its body's full-suite line (only main's own failures allowed).
2. **Step 6 follow-ups, one PR:** the `tasks.categories` config (the category list is in code; cli-core's
   settings schema refuses unknown sections), MCP `tasks_claim` / `tasks_release`, `agenda --category`.
   Decision yours: where the categories setting lives — the plan leans on the store-wide `config` like
   `search_stemmers`, so tg, max and memo share one list. Check: `pnpm typecheck && pnpm lint && pnpm docs:check`
   and the tasks tests.
3. **Rebase and merge cli-core#1121** (`search mail` and MCP `search_mail` leave tg/max with a pointer to memo;
   `search all` excludes mail). Search code moved a lot on main; expect real conflicts. Check: full suite.
4. **Release cli-core** with all of the above: `bin/release` from a clean `main` checkout, or — when the main
   checkout holds others' files — a `chore: release X` PR, then `gh workflow run release.yml --ref main` while
   holding `/run/user/1000/leemour-release.lock` with a `.who` note; announce on #849 before and "run started"
   after. Check: `npm view @wirecat/cli-core version` shows it and tag `vX` exists.
5. **tg, then max** move their cli-core pin (tg-cli#487, max-cli#612 carry the `search mail` change): rebase, bump
   the pin, update docs and test matrices for the breaking `tasks add --category`, `pnpm contracts:upgrade`,
   `parity:check`, release with `bin/release`. tg: two hours between releases. max: write
   `releases/<version>.md` in cli-private for the exact main commit — it needs the **owner's** sign-off line,
   which an agent never writes for them; leave max ready and say so. Then merge cli-docs#199 and cli-memo#135
   (memo's docs: tagged mail is found with `memo search mail`, not `tg search mail`).
6. **Public tasks page** (cli-docs `content/docs/tasks.md` and `tasks-architecture.mdx`, en/ru/es): say "the
   agent reviewing after sync decides likely duplicates; the owner sees only the unsure ones", and drop
   "Planned" from what is built.

## 5. What bites

1. **The merge guard.** The Bash tool runs zsh, where `set -e` does not stop a chain. Every merge goes through
   `bash -euo pipefail -c '…'` with `|| { echo STOP; exit 1; }` on each check: base is `main` (a stacked PR
   merges into its base branch), `mergeable` is `MERGEABLE` (poll past `UNKNOWN`), checks green, no new
   non-own comment on #849 since the last read, no release run in progress — then post one line on #849 and
   `gh pr merge --squash`. Every other check (memo's `lint:commands`, tests) goes inside the same script, before
   the merge.
2. **Main moves faster than a full suite runs** (5–7 minutes; other sessions merge and release every few
   minutes, often without a #849 line). Run the full suite once, then after a rebase run only the static checks
   and the touched tests, push, and merge at once.
3. **Releases swallow changelog lines.** After every rebase, check `## Unreleased` still holds your entries and
   that none sit under a dated heading; memo's PR CI (`changelog / guard`) refuses a line under a released one.
4. **File line caps are a ratchet** (`biome.json` `noExcessiveLinesPerFile` for `store.ts`, `schema.ts`,
   `spec.mjs`): raise by exactly the lines added, and say so in the commit.
5. **Store migrations are reserved first** in `docs/dev/COORDINATION.md` by a docs PR merged before the migration.
6. **main fails three parity tests by itself** (the `parity.json` row `bot api --allow-any-file`, and
   `STANDARD.md` rendering), flagged on #849 for the owner of #1234. Only those three may fail in a full run.
7. **A rule-made task has no text** to compare until it gets a title: matching it uses person, category and
   reply chain only. Tasks never keep message text, by design.
8. **Codex sets no session variable** that could be confirmed; a Codex claim holder falls back to `codex`
   unless `--holder` is passed.

## 6. Do not touch

- cli-memo#118, #171, tg-cli#469/#518, max-cli#562, cli-core#1019, cli-docs#234 — other sessions' PRs.
- The parity row `bot api --allow-any-file` — #1234's owner decides it.
- Other sessions' temporary folders under `/var/tmp/claude/claude-1000/` — the owner said not to delete them.
- max's release sign-off line — only the owner writes it.

## 7. Check

```sh
cd <worktree> && pnpm typecheck && pnpm lint && pnpm docs:check && pnpm schema:check && pnpm vitest run --maxWorkers=3
```
