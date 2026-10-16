# Coordination between parallel sessions

Several sessions work on cli-core, tg-cli and max-cli at once. This page is what they share.

## Store migrations

**The next free migration version is 18.** Version 17 is taken by the agent's close of a task (`tasks.close_certainty` and the close a task waits on the owner for — `close_suggested_as`, `_by`, `_certainty`, `_reason`, `_at`; tasks plan, follow-up-of and agent close, 2026-10-16). Version 16 is taken by mentions in documents, notes and mail (triggers that queue `documents.body`, `notes.body` and `emails` subject and text for mentions, as messages and attachments are; mentions plan phase 1e, 2026-10-15). Version 15 is taken by `task_pairs` (pairs of tasks that may be one job and every decision on them — review, unsure, merged, rejected, attach, new — with the levels the score came from; tasks plan step 5, 2026-10-15). Version 14 is taken by `task_words` / `task_stems` (full-text tables
for tasks, kept by task writes, for the duplicate check's candidate lookup; tasks plan step 3, 2026-10-15). Version 13 is taken by task fields (`category`, `claimed_by`,
`claimed_until`, per-type keys for message tasks, tasks as a taggable type; tasks plan step 2, 2026-10-14). Version 12 is taken by `mail_rules` (mail rules move from memo's
config into the store, with the rule that decided each email; universal mail rules plan in cli-memo, 2026-10-14).
Version 11 is taken by organizations owning identities
(`organization_identities`, a table of its own beside `identity_links`; mentions plan phase 1c, owner's choice,
2026-10-14). Version 10 is taken by mentions in file texts and voice transcripts (triggers queue an
attachment's text; mentions plan phase 1e, 2026-10-14). Version 9 is taken by partial indexes over the folded copies still to
fill (rows an older build wrote after version 8; slice S5b follow-up, 2026-10-14). Version 8 is taken by folded copies of filterable names (`tasks.title`,
`tasks.close_reason`, `attachments.name`, `attachments.local_path`, `meetings.title`; slice S5b, 2026-10-14). Version 7 is taken by `mentions` (phones, e-mail, links and documents
found in text, plan in pull request #1036, 2026-10-13). Version 6 is taken by snake_case keys in stored query trees
(`lower_inclusive`, `upper_inclusive`, `must_not` in `searches.params`; stream D-2a, 2026-10-13). Version 5 is taken by
file-name words (`attachment_name_words`); durable task worker claims, which had reserved 5, need a new number.
Version 4 is taken by `tasks.next_check_at` (task follow-ups, 2026-10-11). Version 3 is taken by canonical project/tag/topic aliases
(Codex root, meeting intelligence wave, 2026-10-11). Version 2 is taken by facts (decisions become facts with a kind;
kind-fact memories move into the facts store), owner's NEED-949 A, 2026-10-11. Versions are the `version` field of `MANIFEST` in
`src/store/sqlite/manifest.ts`; the initial migration is 1. Take the next one by editing this line in a pull
request of its own, merged before the migration: the runner skips every version at or below the file's, so two
branches holding the same version would leave one migration unapplied on stores that ran the other.

Numbers from before the store rewrite (up to 29, including the one reserved for `feat/combined-search`) mean
nothing now.

## Releases

- **Announce before you merge into `main` or start a release** — in
  [issue #849](https://github.com/WireCatLabs/cli-core/issues/849), one line, after reading its latest
  comments and `gh run list --workflow release.yml`. Two sessions merge and release here, and on 2026-10-10
  one released 0.219.0 from a `main` one merge short of the other's work (owner's rule, 2026-10-11).
- Release only through `bin/release`: `gh workflow run release.yml` started by hand skips the lock below.
  When you must start it by hand, pass the `main` you checked: `-f commit=<its full 40-character sha>`.
  The run refuses any other commit, so a merge that lands after your checks is not published.
- Each session releases its own merged work: `git fetch`, `npm view`, a `chore: release` pull request
  that raises the version from what npm really has, then `bin/release`.
- `bin/release` in every repository takes one machine-wide lock (`$XDG_RUNTIME_DIR/leemour-release.lock`),
  so only one release of any package runs at a time on this machine. tg-cli and max-cli also refuse a
  release within two hours of their last one; cli-core has no such gap.
- To try an unreleased cli-core in tg-cli first, use `bin/try-messaging` in the tg worktree, never a
  committed `file:` path.

## Who owns what

Open pull requests are the source of truth for claimed work (`gh pr list` in each repository). A plan
for open work lives in `docs/dev/` beside this page; a plan whose work is merged is deleted.
