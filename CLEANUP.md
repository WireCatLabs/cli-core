# Cleanup

- 2026-10-14: `/tmp/meeting-evidence-sdk-schema-preview3` and `/tmp/meeting-evidence-sdk-final-preview` — local-only MCP/continuation previews for synthetic Zoom checks; never publish or commit their file dependencies, retain pending approved cleanup.

- 2026-10-14: `/tmp/meeting-evidence-sdk-schema-preview` (failed build artifact; do not use) and `/tmp/meeting-evidence-sdk-schema-preview2` — local-only schema integration artifacts, never release or commit their file dependencies; retain pending approved cleanup.

- 2026-10-14: `.worktrees/meeting-project-discovery`, branch `feat/meeting-search-host-binding`, `/tmp/meeting-evidence-sdk-preview` and `/tmp/meeting-evidence-sdk-host-binding-preview` — host-composition SDK changes and local-only preview tarballs; never publish these same-version development artifacts, retain until approved cleanup.

- 2026-10-14: `.worktrees/meeting-evidence-contract-fix`, branch `docs/meeting-project-evidence-path` — documentation-only command-path correction; retain until owner-approved cleanup.
- 2026-10-14: `../zoom-cli/.worktrees/meeting-evidence-contract-fix`, branch `docs/meeting-project-evidence-path` — unused clean Zoom checkout created during command-boundary review; retain until owner-approved cleanup.
- 2026-10-14: `.worktrees/meeting-project-discovery`, branch `feat/meeting-project-evidence` — shared evidence CLI/MCP implementation and synthetic fixtures retained for review; remove only in the owner-approved cleanup batch.

- 2026-10-14: `.worktrees/meeting-participant-discovery` and `/tmp/meeting-test-people-*` — isolated bounded participant lookup implementation and invented SQLite fixtures; retain until the owner's cleanup batch.

- `scripts/parity-convert.ts` — the one-off rewrite of `parity.json` into the N-CLI shape; delete once no open branch edits the old shape (feat/parity-n-clis). 2026-10-01
- 2026-10-10: the `/.worktrees/` line in this checkout's `.git/info/exclude` — added so worktrees under `.worktrees/` do not show as untracked; drop it if `.worktrees/` goes into `.gitignore` or stops being used.
- `bench/message-search-quality/`, `docs/dev/combined-search-evaluation.md`, `docs/dev/combined-search-model-research.md` — owner requested transfer to cli-testing/performance/search; copied and hash-verified before removal in this batch. 2026-10-09
- 2026-10-10: `.worktrees/store-schema-requests` and `.worktrees/store-drop-v2` — the schema-requests (#827) and drop-"v2" branches; remove with their branches once merged into `main`.
- 2026-10-10: `.worktrees/docs-ai-schema` — detached worktree of `max-cli/docs_ai` for the schema spec and the journal; remove after its commits are on `docs_ai` main (`git -C ~/Projects/AI/max-cli/docs_ai worktree remove …`).
- 2026-10-11: the empty `decisions` table (store version 1) — replaced by `facts` in version 2; drop it in the next migration that raises `minCompatible`, since dropping a table locks older builds out (feat/store-facts).
- 2026-10-12: `.worktrees/meeting-search-filters`, branch `feat/meeting-search-filters`, and its `tsconfig.meeting-filters.json` / `vitest.meeting-filters.config.ts` — retained development worktree and diagnostic configs for the Oxc package-export resolution failure; remove only in the owner's approved cleanup batch.
- 2026-10-13: `../cli-messaging-wt-parity-link`, branch `ci/parity-link-checkout` — worktree for building tg-cli and max-cli against this checkout in Parity; remove once merged.
- 2026-10-13: `../cli-messaging-wt-parity-branch`, branch `ci/parity-same-name-branch` — worktree for Parity building an app's same-name branch; remove once merged.
- 2026-10-13: `../cli-messaging-wt-app-ref`, branch `ci/release-app-ref` — worktree for the release `app_ref` input to Parity; remove once merged.
- 2026-10-13: `../cli-messaging-wt-d2a` (branch `feat/d2a-cli-base-query`) and `../cli-messaging-wt-d2a-reserve` (branch `docs/reserve-store-6-query-ast`) — stream D-2a worktrees; remove once their PRs are merged.
- 2026-10-13: `../cli-messaging-wt-mcp-default-test`, branch `fix/mcp-entry-default-test` — worktree for the 0.260.0 changelog section; remove once merged.
- 2026-10-13: `../cli-messaging-wt-a2-core`, branches `feat/a2-core-entities` and `feat/a2-core-output` — stream A a2-core worktree; remove once both PRs are merged.
- 2026-10-14: `.worktrees/meeting-hit-context`, branch `feat/meeting-hit-context` — shared cue context, compact passages and synthetic adapter proofs; retain until approved cleanup.
- /home/leemour/Projects/AI/cli-messaging-wt-a2-s3 — worktree of the a2 S3 slice (store lists); remove after its PRs merge. 2026-10-14
- /home/leemour/Projects/AI/cli-messaging-wt-a2-s3b — second worktree of the a2 S3 slice (conversations list); remove after its PR merges. 2026-10-14
- `/home/leemour/Projects/AI/cli-messaging-wt-a2-s1` (feat/a2-s1-chats-contacts): stream A wave 2 slice S1 worktree; remove after merge (2026-10-14)
- 2026-10-14: `../cli-messaging-wt-a2-s3c`, branch `feat/a2-s3-store-lists-3` and later S3 part-3 branches — wave 2 slice S3 (attachments, meetings, jobs lists, agenda); remove once merged.
- 2026-10-14: `../cli-messaging-wt-a2-s3d`, branch `feat/a2-s3-meetings-list` — wave 2 slice S3 (meetings list onto the envelope); remove once merged.
- 2026-10-14: `../cli-messaging-wt-a2-s3d` also carries branch `feat/a2-s3-searches` (saved searches onto the envelope); remove once merged.

- 2026-10-14: `.worktrees/meeting-project-discovery`, branch `feat/meeting-project-discovery`, and `/tmp/meeting-test-project-words-*` — retained SDK discovery implementation and invented fixtures; remove in the owner-approved cleanup batch.
- 2026-10-14: `../cli-base/.worktrees/meeting-project-aliases`, branch `feat/meeting-project-aliases` — unused clean vocabulary-design checkout; retained pending the owner-approved cleanup batch.
- 2026-10-14: `../cli-messaging-wt-a2-s5a`, branches `feat/a2-s5a-*` — wave 2 slice S5a (account, runtime, bot onto the envelope; removals); remove once merged.
- 2026-10-14: `../cli-messaging-wt-a2-s5a-r` — second worktree of S5a for rebasing its PRs while the first is busy; remove once merged.

- 2026-10-14: retain `feat/meeting-occurrence-foundation`, its worktree and isolated `/var/tmp/core-occurrence-*` states and `/tmp/core-occurrence-*` logs until owner-approved cleanup; normalized synthetic providers only.

- 2026-10-14: retain `feat/public-answer-policy` and its worktree plus isolated validation artifacts until owner-approved cleanup; public exports for standalone CLI/MCP consumers.
- 2026-10-14: `../cli-core-wt-account-from-command`, branch `feat/account-from-command` — Messenger.accountOf for memo; remove after its PR merges.
- 2026-10-14: `../cli-core-wt-task-link`, branch `feat/task-link-relations` — task: target is a task relation; remove after its PR merges.
- 2026-10-14: `../cli-core-wt-tasks-plan`, branch `docs/tasks-plan` — tasks design plan; remove after its PR merges.
- 2026-10-14: `../cli-core-wt-task-similarity`, branch `feat/task-similarity` — task similarity scoring module; remove after its PR merges.
- `bench/search/store-chain.ts` — times the legacy word-search chain (`search/search.js`, `matchWords`, `SCOPE_TOKEN_LIMIT`), all removed in refactor/drop-legacy-search; it no longer runs. Keep `bench/search/results.md` as the record. 2026-10-14
- 2026-10-14: `../cli-core-wt-reserve-13`, branch `docs/reserve-migration-13` — reserves store migration 13 for task fields; remove after its PR merges.
- 2026-10-14: `../cli-core-wt-task-fields`, branch `feat/task-fields` — tasks plan step 2 (task fields, store version 13); remove after its PR merges.
- 2026-10-15: `../cli-core-wt-rules-on-sync`, branch `feat/rules-on-sync` — tasks plan step 7; remove after its PR merges.
- `~/Projects/AI/cli-core-wt-task-search` and `~/Projects/AI/cli-core-wt-reserve-14` — worktrees of tasks plan step 3 (#1245 merged); remove once feat/task-search merges. 2026-10-15
- 2026-10-15: `~/Projects/AI/cli-core-wt-reserve-15`, branch `docs/reserve-migration-15` — worktree for the store migration 15 reservation; remove once the PR is merged.
- 2026-10-15: `../cli-core-wt-tasks-handoff`, branch `docs/tasks-handoff` — tasks handoff; remove after its PR merges.
- 2026-10-15: `~/Projects/AI/cli-core-wt-task-duplicates`, branch `feat/task-duplicates` — tasks plan step 5; remove after its PR merges.
- 2026-10-15: `~/Projects/AI/cli-core-wt-search-mail`, local branches `feat/source-search-own` and `search-mail-rebase` — #1121 (tg and max stop searching mail); remove after it merges.
- 2026-10-14: local branch `backup/source-search-own-159de861` in cli-core — the notes-and-tasks version of feat/source-search-own before the owner reversed it; remove once #1121 merges.
