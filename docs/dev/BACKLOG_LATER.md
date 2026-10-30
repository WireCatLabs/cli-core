# Backlog — later

Someday work: P3 items, nice-to-haves and research. Same ids, marks and one-line format as
[BACKLOG.md](BACKLOG.md#rules). An item moves to [BACKLOG.md](BACKLOG.md) when it becomes P2.

- **CORE-13** · P3 · Serve relay, what v1 leaves out: a Windows named pipe, `ask` forwarded to the client, waiting
  for a starting serve, per-watcher buffers, `mcp serve --http` through serve, a path type on options.
  [The serve relay](ARCHITECTURE.md#the-serve-relay) · [notes](BACKLOG-NOTES.md#core-13).
- **CORE-14** · P3 · 🚩 One Markdown parser: tg and wa use `parseMarkdownSpans`; max-cli's dialect waits for the
  owner, and the legacy `parseMarkdown` (`src/index.ts:12`) goes in the next breaking release.
  [Notes](BACKLOG-NOTES.md#core-14).
- **CORE-15** · P3 · Messenger feature gaps: albums, typing, location, MAX cloud password, video notes. Proposed, not
  claimed: [messenger-feature-gaps.md](messenger-feature-gaps.md).
- **CORE-16** · P3 · 🚩 Chat briefs and news digests for the owner's agent; needs the owner's scope before a plan.
  [Notes](BACKLOG-NOTES.md#core-16).
- **CORE-17** · P3 · Mail embedding, not measured yet: a model-based line classifier, and a run on the owner's
  mailbox. [Notes](BACKLOG-NOTES.md#core-17).
- **CORE-18** · P3 · An opt-in reranker for note and document search, behind its own flag; a fresh, frozen query set
  first. [Notes](BACKLOG-NOTES.md#core-18) · [combined-search.md](combined-search.md).
- **CORE-19** · P3 · EmbeddingGemma against e5-small on documents, measured with CORE-18.
  [Notes](BACKLOG-NOTES.md#core-19).
- **CORE-20** · P3 · No query-expansion model: agents search again in other words; optional and off by default, if
  ever. [Notes](BACKLOG-NOTES.md#core-20).
- **CORE-21** · P3 · 🚩 One registry for what gets a vector; owner direction given, design not approved.
  [embedding-registry-plan.md](embedding-registry-plan.md).
- **CORE-22** · P3 · Embedding throughput: more sessions over all cores, batched inputs, a native ONNX Runtime.
  [Notes](BACKLOG-NOTES.md#core-22).
- **CORE-23** · P3 · Speech throughput: one recognizer per pass, then workers over files
  (`src/speech/transcribe.ts`). [Notes](BACKLOG-NOTES.md#core-23).
- **CORE-24** · P3 · Mentions: link found names and places to people and organizations through `links`
  ([mentions-plan.md](mentions-plan.md#phases), phase 3).
- **CORE-25** · P3 · Finish the rename: the `@wirecat/cli-tasks` and `@wirecat/cli-meetings` deprecation notices
  still point at the deprecated `@wirecat/cli-messaging`, and the parity build keeps its old-name fallback
  (`scripts/parity/build-app.sh:25`). [merge-shared-packages-plan.md](merge-shared-packages-plan.md).
- **CORE-30** · P3 · `messages sync <chat> --files` collects a chat completely: sync history, download files, read
  their text, transcribe, reindex, and report coverage at the end (owner's name, 2026-10-24). Found in the
  2026-10-12 field test (#1019).
- **CORE-31** · P3 · `attachments list is:needs_text` lists files with no text but not why: say per file what would
  give it text (a reader, OCR, transcription) and the command that does it. `src/store/sqlite/attachment-texts.ts:198`.
- **CORE-41** · P3 · Build the command tree once per process: `run()` builds a fresh Commander tree on every call
  (`src/cli/program.ts:286`) because it writes the call's state into it — `provide(program, environment)`, a
  `preAction` hook, `setOptionValue("profile")` before the parse. An MCP server pays ~16 ms per call for tg (~10 ms
  once the self-checks run once per process). Split the static tree from a per-call context
  ([WC-ARCH-22](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/architecture.md#wc-arch-22--build-the-command-tree-once-keep-each-calls-state-out-of-it)).
