# Handoff — search without `--language legacy`, and the next memo and search improvements (2026-10-12)

The trail, optional: the field test that found these items —
[cli-private reports/2026-10-12-polevoy-test-tg-memo-drive.md](https://github.com/WireCatLabs/cli-private/blob/main/reports/2026-10-12-polevoy-test-tg-memo-drive.md).

## 0. State on 2026-10-13 (resume here)

Owner rulings 2026-10-13: typo search = option B (strict first; one-edit corrections and 3+ letter
beginnings only when strict finds nothing; each forgiven hit labelled; on an empty answer MCP
`next_steps` and one stderr line point at `--discover`; partial matches stay opt-in). Drive plan
approved; nothing in drive.db to keep; Drive hits show Google URL + last Google edit time; remove
`DRIVE_STORE`. `chats documents list <chat>` with a stored message→document link written by
`drive sync`. Every search must let the owner choose accounts/profiles for every entity.

Merged: cm#1020 (export envelope), cm#1021 (bot author name), cm#1022 (Drive plan), cm#1024
(typo plan, `docs/dev/typo-search-default-plan.md`), cm#1026 (STANDARD: `chats documents list`),
cli-memo#116 (memo refuses drive's folder), cli-testing#37 (typo benchmark + results). None
released yet.

Not done, in order:
1. **Typo work item 1:** STANDARD PR for `match: corrected | beginnings`, `corrections`, the
   `--language legacy` deprecation and the `next_steps` hint. Then the service code — it builds on
   cm#1025 (bare word covers transcripts, file names, file text; another session), check it first.
2. **`--source` everywhere:** plan + STANDARD rows, not started (worktree
   `cli-messaging-wt-source-everywhere` is empty). Extend the existing `--source` list to `search all`,
   notes folders and Drive documents; the answer names the accounts searched. Also record Q2/Q3
   answers in `docs/dev/drive-in-store-plan.md`. Owner sees the value grammar before merge.
3. **Drive switch:** waits for drive#19 and a cli-messaging release with cm#1017 (other agents).
4. **`chats documents list`:** implement per `docs/dev/chat-documents-plan.md` (merged in #1026).
5. **Release cli-messaging** when memo#111 or cm#1017 needs it; then pin bumps.
6. Items 5 and 6 below wait for cm#1013 / cm#1006. Item 4's name (`messages sync <chat> --files`)
   is proposed on #1019, not ruled.

## 1. What this is

cli-messaging is the shared library under `tg`, `max` and `memo` (one local store, one search). The owner wants
search to forgive typos **by default**, so `--language legacy` can go away, plus a set of smaller improvements
to memo and search that a real-project test showed. Twelve fixes from that test are already open as PRs (listed
in section 6) — this handoff is what is **not** in progress. Project rules: [CLAUDE.md](../../CLAUDE.md),
command rules: [STANDARD.md](STANDARD.md).

## 2. Orient in one call

```sh
cd /home/leemour/Projects/AI/cli-messaging && git fetch -q && {
  echo "== backlog"; git show origin/main:docs/dev/BACKLOG.md
  echo "== search handoff (state of --discover)"; git show origin/main:docs/dev/combined-search-handoff.md
  echo "== default-switch gates"; git show origin/main:docs/dev/combined-search.md | sed -n '1,60p'
  echo "== compatibility and release order"; git show origin/main:docs/dev/combined-search.md | sed -n '245,286p'
  echo "== search hierarchy rule"; git show origin/main:docs/dev/STANDARD.md | sed -n '179,186p'
  echo "== field-test proposals"; sed -n '155,195p' /home/leemour/Projects/AI/max-cli/docs_ai/reports/2026-10-12-polevoy-test-tg-memo-drive.md
  echo "== open PRs (do not duplicate)"
  gh pr list -R WireCatLabs/cli-messaging --limit 40 --json number,title -q '.[]|"cm#\(.number) \(.title)"'
  gh pr list -R WireCatLabs/cli-memo --limit 20 --json number,title -q '.[]|"memo#\(.number) \(.title)"'
  gh pr list -R WireCatLabs/drive-cli --limit 10 --json number,title -q '.[]|"drive#\(.number) \(.title)"'
} > ~/.cache/search-memo-next-orient.txt 2>&1
```

Then read `~/.cache/search-memo-next-orient.txt`. It shows: what is still open in the backlog; what `--discover`
already does and what it does not; the quality gates any default switch must pass; the release order for a
default change; where every search command lives; the owner-facing proposals from the field test; and every
open PR, so you do not redo one.

## 3. Read in this order (only if the orient output is not enough)

1. [combined-search.md](combined-search.md) `:177-244` — how candidates from strict, prefix, correction and
   stem matchers are fused and ranked; what failed the gates and why.
2. [cli-testing performance/search](https://github.com/WireCatLabs/cli-testing/blob/63de1d7870e5d983bbc05dd253cdb66d0bbfd7cd/performance/search/README.md)
   — how to reproduce the benchmark (2 616 synthetic messages, 96 queries) before and after your change.
3. `src/services/messages-combined.ts` and `src/services/messages-discovery.ts` — the code that already merges
   word, prefix and correction candidates; the legacy path you are replacing lives behind `--language legacy`.
4. [docs/search/query-language.md](../search/query-language.md) `:1-60` — the user-facing promise you will change.

## 4. Do

Ordered by value. Items 1–2 are the important ones; 3–8 are quick wins (each about one PR).

1. **Typo-tolerant search by default; remove `--language legacy`.** Strict Lucene syntax stays; plain words
   also match corrections and prefixes, ranked below exact matches, each hit labelled with how it matched.
   **Decision yours:** go through the gates in `combined-search.md:40-50` on the benchmark, or propose to the
   owner a narrower first step (typo correction only for single words with no exact hit). The plan leans on the
   gates because the last default switch failed them. Get the owner's approval of the plan **before** coding
   (backlog rule). Then: deprecate `--language legacy` as an alias for one or two releases (stderr hint), keep
   `--exact` for no-forgiveness. Check: benchmark run shows every gate passed; `pnpm test`.
2. **Drive documents in the shared store.** drive-cli keeps its own `~/.local/share/drive-cli/drive.db`, so
   `memo search all` and `tg search all` never see Drive. Design how drive writes documents as shared-store
   notes/documents (with source URL and folder), so `search all` covers them. **Decision yours:** drive writes
   to the shared store directly, or memo imports drive's db — the owner's rule is one store. Write a short plan
   first; it touches drive-cli too. Check: `memo search all <word from a Google Doc>` returns the doc.
3. **Documents named in a chat.** A command that lists every Google Docs/Drive link in a chat's stored messages
   with the document title, date, who sent it, and whether it is in the store — and links the message to the
   document. It is a hand-written script now. Name it by STANDARD (resource + verb from the list).
4. **One command to collect a chat completely**: sync history + download files + read file text + transcribe +
   reindex, with a coverage report at the end. Not called `archive` (the owner: it sounds like archiving the
   chat). Propose the name per STANDARD and the glossary PR; owner approves.
5. **`attachments` that still need text** — list files without text and say for each what would give it text
   (reader, OCR, transcription). `attachments list --needs-text` exists; add the reason and the command.
6. **`store gaps` reports incomplete preparation silently**, like `store fetch --catch-up` did before cm#1006.
   Apply the same honest status.
7. **`store export --json` lacks `page`, `limit`, `hasMore`** that the output contract asks of every list.
8. **The agent's name is stored but not shown** for facts, memories and actions written by an agent (memo#111
   records it as a bot id). Add a public way to resolve a bot author to its name, and show it.

Owner decisions still open — do not implement, but do not contradict either:
- An agent may approve its own proposals in memo (`facts accept` etc. from an agent terminal).
- `store export` with transcripts and file text (changes the export format).
- memo tags are Latin only (`a–z`, digits, hyphens); a Russian project translates its tags.

## 5. What bites

1. **The default search rule just changed.** The owner decided: plain search covers message text, voice
   transcripts, file names and file text; `transcript:`, `filename:`, `content:` narrow it. That work is in
   progress on top of cm#1010 — and cm#1015 / memo#112 still say "file text needs `content:`". Build item 1 on
   the new default, not on the old one; check where those PRs stand first.
2. **`sync` is being renamed.** `store fetch` → `messages sync`, `memo import` → `memo sync` (owner,
   2026-10-12), with a glossary PR in this repo's `docs/dev`. Use the new words in anything you add.
3. **Every new verb, field or option goes into STANDARD.md first**, in its own PR, with owner approval; the
   parity manifest (`pnpm parity:audit`) fails on a command or option it does not know.
4. **tg and max pin an exact cli-messaging version.** A fix here reaches them only after a release and a pin
   bump; the installed `tg` keeps the old behaviour until then.
5. **The `## Unreleased` changelog section is added by almost every open PR** — expect a rebase conflict there
   and resolve by keeping all entries.
6. **zsh does not split an unquoted variable into words.** `for c in "projects add"; memo $c --help` passes one
   argument. Use arrays (`F=(a b)`, `"${F[@]}"`) in scripts.
7. **pnpm 11 holds versions younger than a day.** `pnpm add -g @wirecat/tg-cli@latest` installs an older one;
   name the version to get the new one.
8. **The live store is the owner's.** Read it only (`tg default --offline …`, `memo … --json`); never write
   message text to a file, a test or a commit; the profile is always explicit.

## 6. Do not touch

In progress by other agents — read their PRs, do not redo them:
- cm#1006–#1017: honest store status, export help, upgrade read-back, last message in dialog, transcripts
  searchable, `has:file`, speech logs, missing reader, file readers as dependencies, help text, spreadsheets as
  rows, 2M-character notes; plus "search everywhere by default" and the `sync` rename and glossary.
- memo#109–#112 and the key-documents feature (key marks per project, first in `projects context`).
- drive-cli#19 (Sheets, PDF, Office files; `maxTextChars`).

## 7. Check

```sh
cd /home/leemour/Projects/AI/cli-messaging && pnpm test && pnpm lint && pnpm typecheck && pnpm docs:check && pnpm parity:audit && pnpm standards:check
cd /home/leemour/Projects/AI/cli-memo && pnpm test && pnpm lint && pnpm typecheck && pnpm generate:check
```

For item 1, also the benchmark from cli-testing `performance/search` (its README has the three commands) — every
gate in `combined-search.md:40-50` must pass and be reported in the PR. No real account is needed for any of
this; the tests build their own stores.
