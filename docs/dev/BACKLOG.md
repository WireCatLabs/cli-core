# Backlog

Open work for this cycle only, most important first. Someday work is in [BACKLOG_LATER.md](BACKLOG_LATER.md); the
research behind an item is in [BACKLOG-NOTES.md](BACKLOG-NOTES.md). What developers can build on today and what comes
next is the [roadmap](../roadmap.md).

## Rules

- **An id is permanent** and never reused. Take one with `bin/next-id CORE`: one counter for every worktree on the
  machine, under a lock, and never below the highest number on any branch.
- **One item:** id · priority · title · where the work starts (`path:line`, a plan or a pull request) · details.
  One to three lines; longer analysis goes to [BACKLOG-NOTES.md](BACKLOG-NOTES.md) or a plan beside this page.
- **Priority:** **P1** broken, untrue to users, an install failure or a security problem: done before WireCat is
  advertised · **P2** this cycle · **P3** someday, in [BACKLOG_LATER.md](BACKLOG_LATER.md).
- **Mark:** none — not started · 🚧 `<branch>` — taken · 🟡 — half done, the rest named · ⏸️ — deferred by the owner ·
  🚩 — waits on an owner decision.
- **Claim before code:** put `🚧 <branch>` on the line in the first push of the branch.
- **Close in the pull request that ships the work:** delete the line (and its note). The changelog keeps history.

## Launch blockers (P1)

- **CORE-1** · P1 · The MCP server library has three high-severity advisories, so a fresh install of any WireCat CLI
  reports 8 high alerts in `npm audit`, and `npm audit fix --force` offers the deprecated `@wirecat/cli-core@0.20.0`.
  Raise `@modelcontextprotocol/server` 2.1.0 → 2.3.0 (`package.json:168`, dependabot #1699, checks green), release,
  then every CLI adopts it.
- **CORE-2** · P1 · README statements that are no longer true: proximity is refused (`README.md:119`; `"a b"~N` works
  since #1748), "seventeen" optional groups (`:90`; [ADAPTERS.md](ADAPTERS.md#required-core-and-optional-groups) lists
  20), the tool lists leave out wa and drive (`:7`, `:74`), "the profile is the first word of every account command"
  (`:213`; memo takes `--account`, drive `--profile`), and a dated count of breaking versions (`:255`).

## Next (P2)

- **CORE-3** · P2 · 🚩 A smaller install: a fresh `npm i @wirecat/cli-core` is 238 MB. Draft plan waits for the
  owner: [plans/2026-10-18-install-size.md](plans/2026-10-18-install-size.md).
- **CORE-4** · P2 · 🟡 Shared command-lint debt the CLIs baseline: examples and summaries are in open `docs/standards-*`
  and `fix/standards-*` pull requests (#1774–#1814); the flag renames wait for a breaking release.
  [Notes](BACKLOG-NOTES.md#core-4).
- **CORE-5** · P2 · Let a new source join without editing this package: the provider registry is a fixed list
  (`src/domain/providers.ts:14`) and there is no single `/sdk` entry point (`docs/dev/ADAPTERS.md:23`). Needed before
  the Slack, Google Meet and Notion CLIs, and it is the "SDK for new integrations" on the public roadmap. Plan first.
- **CORE-6** · P2 · Search start-up: memo and drive take 1.2–2.4 s a search; measure process start, store open and
  model load first. [Notes](BACKLOG-NOTES.md#core-6).
- **CORE-7** · P2 · 🟡 One `--source` for every search: left are document-only selection, provider and kind coverage in
  answers, and memo's work item 5. [source-everywhere-plan.md](source-everywhere-plan.md).
- **CORE-8** · P2 · Typo-tolerant search by default (approved option B); waits on plain search covering transcripts,
  file names and file text. [typo-search-default-plan.md](typo-search-default-plan.md) ·
  [notes](BACKLOG-NOTES.md#core-8).
- **CORE-9** · P2 · Generated tags for notes, documents and messages (approved, not built: `taggings` has no status
  column, `src/store/sqlite/schema.ts:1689`). [generated-tags-plan.md](generated-tags-plan.md) ·
  [notes](BACKLOG-NOTES.md#core-9).
- **CORE-10** · P2 · 🚧 `feat/reviewed-tag-apply` Reviewed tag consolidation (draft #1577, store version 30 reserved in
  [COORDINATION.md](COORDINATION.md#store-migrations)). Foundation: [TAG-CONSOLIDATION.md](TAG-CONSOLIDATION.md).
- **CORE-11** · P2 · 🚧 `feat/transcript-index` Voice-note transcripts searchable in any word form (#1761, store
  version 29).
- **CORE-12** · P2 · 🚧 `feat/media-archive` Verified media archives and daily timers (draft #1758).
