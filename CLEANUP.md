# Cleanup

- `scripts/parity-convert.ts` — the one-off rewrite of `parity.json` into the N-CLI shape; delete once no open branch edits the old shape (feat/parity-n-clis). 2026-10-01
- 2026-10-10: the `/.worktrees/` line in this checkout's `.git/info/exclude` — added so worktrees under `.worktrees/` do not show as untracked; drop it if `.worktrees/` goes into `.gitignore` or stops being used.
- `bench/message-search-quality/`, `docs/dev/combined-search-evaluation.md`, `docs/dev/combined-search-model-research.md` — owner requested transfer to cli-testing/performance/search; copied and hash-verified before removal in this batch. 2026-10-09
- 2026-10-10: `.worktrees/store-schema-requests` and `.worktrees/store-drop-v2` — the schema-requests (#827) and drop-"v2" branches; remove with their branches once merged into `main`.
- 2026-10-10: `.worktrees/docs-ai-schema` — detached worktree of `max-cli/docs_ai` for the schema spec and the journal; remove after its commits are on `docs_ai` main (`git -C ~/Projects/AI/max-cli/docs_ai worktree remove …`).
- 2026-10-11: the empty `decisions` table (store version 1) — replaced by `facts` in version 2; drop it in the next migration that raises `minCompatible`, since dropping a table locks older builds out (feat/store-facts).
- 2026-10-12: `.worktrees/meeting-search-filters`, branch `feat/meeting-search-filters`, and its `tsconfig.meeting-filters.json` / `vitest.meeting-filters.config.ts` — retained development worktree and diagnostic configs for the Oxc package-export resolution failure; remove only in the owner's approved cleanup batch.
