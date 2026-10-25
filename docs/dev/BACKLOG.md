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

None open.

## Next (P2)

- **CORE-36** · P2 · 🚧 `fix/shared-contract-audit` Enforce shared command contracts by default; exact, reasoned overrides only. Export actual schemas/reasons for complete cross-CLI audits.

- **CORE-40** · P2 · 🚩 Start a command without loading every command: `./cli` still loads ~880 files (~400 ms) for
  any command but a bare `--version`, and no single cut frees more than 119 of them. Owner chooses: lazy action bodies
  in waves, or a per-tool bundle. [Evidence and the two options](BACKLOG-NOTES.md#core-40).
- **CORE-3** · P2 · 🚩 A smaller install: a fresh `npm i @wirecat/cli-core` is 238 MB. Draft plan waits for the
  owner: [plans/2026-10-18-install-size.md](plans/2026-10-18-install-size.md).
- **CORE-4** · P2 · 🟡 🚧 `fix/standards-vocabulary-paths` The audited personal-account result entities,
  examples and list queries are merged. Canonical command paths and removal of compatibility spellings ship in
  #1837 (owner, 2026-10-24); every CLI adopts them in the same-day cli-core raise. New bot query/schema gaps are separate
  from the original personal-account audit. [Notes](BACKLOG-NOTES.md#core-4).
- **CORE-5** · P2 · Let a new source join without editing this package: the provider list is fixed
  (`src/domain/providers.ts:14`) and Google Drive is hard-coded in the document code
  (`src/services/document-source.ts:8,17`). Needed before the Slack, Google Meet, Notion and Calendar CLIs. No
  separate SDK: cli-core is the shared base (owner, 2026-10-23). Plan first.
- **CORE-6** · P2 · 🟡 Search start-up measured: model open 1.44 s, empty-store reopen 8.4 ms, bare Node 31.7 ms
  (medians). Next compare one-shot CLI and long-lived MCP on the same synthetic corpus before optimizing.
  [Runner and limits](https://github.com/WireCatLabs/cli-testing/tree/main/performance/search/startup) · [notes](BACKLOG-NOTES.md#core-6).
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
- **CORE-33** · P2 · `stats messages counters refresh` becomes `stats messages counters sync`: `refresh` is the
  word the vocabulary rules out. tg, max and wa. After #1837.
