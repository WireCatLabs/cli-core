# Coordination between parallel sessions

Several sessions work on cli-core, tg-cli and max-cli at once. This page is what they share.

## Store migrations

**The next free migration version is 29.** Version 28 is reserved for reviewed tag redirects and text-free consolidation receipts, including a structural tag/automatic-claim compatibility boundary (Codex meetings/tag work, 2026-10-18; draft #1577, moved from 25 by the owner's choice NEED-1559, 2026-10-19, from 26 on 2026-10-21 and from 27 on 2026-10-22 because versions may not leave a gap and #1577 waits on a breaking release). Version 27 is taken by `messages.delivery` (whether the owner's own message in a one-to-one chat was delivered or read, from the messenger's receipts; it only moves forward; wa, 2026-10-22). Version 26 is taken by `message_reactions` (each person's newest reaction to a message, from a messenger that sends reactions one person at a time; the store derives `messages.reactions` totals from them; wa, 2026-10-21). Its implementation and activation remain gated on a coordinated breaking release and consumer rollout; this reservation does not authorize raising `minCompatible` or publishing a new package major. Version 25 is taken by `chat_revisions` (one row per change to a chat's external id, title, membership, scope, search visibility or parent, written by a trigger in the same transaction; an offline read by a re-keyed chat's old id follows it; #1658, owner's choices NEED-1555 and NEED-1559, 2026-10-19). Version 24 is taken by `messages.starred` (the owner's star on a stored message, set by `messages star`/`unstar` and by the messenger's pushed star changes, read by `messages list starred:true` and `search messages is:starred`; wa S3 for S1, 2026-10-18). Version 23 is taken by `chat_events` and `chat_event_people` (who joined, left, was added, removed, promoted or demoted in a chat, and title changes, kept for a messenger whose history is pushed to the store; wa S3 for S2, 2026-10-18). Version 22 is taken by `account_identities.mail_demoted` (memo marks a sender whose fraud signals rank its mail lower in search; owner's choice NEED-1432, 2026-10-17). Version 21 is taken by resumable provider-neutral document annotation transfer receipts and reference mappings (Drive transfer, 2026-10-17). Version 20 is taken by `poll_votes` (each voter's newest vote in a poll the store holds, applied from the messenger's vote events and the owner's own votes; wa gaps, 2026-10-17). Version 19 is taken by the mail sender score (`account_identities.mail_score`, `mail_signals`, `mail_scored_at`: memo's spam score per sender and account, shown on email hits; owner's choice NEED-1403, 2026-10-17). Version 18 is taken by `places` (addresses found in text as records of their own, linked from `place` mentions; mentions plan phase 3, 2026-10-16). Version 17 is taken by the agent's close of a task (`tasks.close_certainty` and the close a task waits on the owner for — `close_suggested_as`, `_by`, `_certainty`, `_reason`, `_at`; tasks plan, follow-up-of and agent close, 2026-10-16). Version 16 is taken by mentions in documents, notes and mail (triggers that queue `documents.body`, `notes.body` and `emails` subject and text for mentions, as messages and attachments are; mentions plan phase 1e, 2026-10-15). Version 15 is taken by `task_pairs` (pairs of tasks that may be one job and every decision on them — review, unsure, merged, rejected, attach, new — with the levels the score came from; tasks plan step 5, 2026-10-15). Version 14 is taken by `task_words` / `task_stems` (full-text tables
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
- Once a publisher captures its checked commit, treat that dated changelog section as frozen,
  even before npm visibility and tagging finish. New work starts a fresh `## Unreleased` above it.
  After rebasing, inspect the actual headings around every new note: a clean rebase or green PR
  does not prove the note belongs to the captured release. Keep the captured section identical to
  its checked source; when a tagged section needs historical correction, restore the exact tag
  section and describe the correction under Unreleased. Never rewrite an immutable release tag.
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
