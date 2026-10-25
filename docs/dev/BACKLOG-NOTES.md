# Backlog notes

The research and analysis behind items in [BACKLOG.md](BACKLOG.md) and [BACKLOG_LATER.md](BACKLOG_LATER.md),
moved here word for word so the lists stay short. A note is deleted with its item.

## CORE-4

cli-core 0.397.0 supplies concise command summaries and positional argument help. The vocabulary migration
uses explicit report/list leaves without compatibility command aliases. A retired command path is an unknown
command, and a saved permission key no command checks stops every command until it is removed. Result schemas
are declared by command group.

The option migration in [#1810](https://github.com/WireCatLabs/cli-core/pull/1810) distinguishes analysis,
embedding and consent providers, tag ownership, stored-answer models and reply-template policies. Catch-up
chat kinds use query terms. CLI and MCP both accept only canonical argument names; the old option spellings are refused.

## CORE-6

- **Search start-up** — memo and drive were reported to take 1.2–2.4 s per CLI search. The synthetic component
  benchmark measured median model open at 1.44 s, empty-store reopen at 8.4 ms, bare Node startup through exit
  at 31.7 ms and store-module import at 251 ms. A second query embedding took 13 ms. Eight new-process samples
  per scenario, e5-small, four threads; filesystem caches were not cleared. This is not an end-to-end CLI search.
  [Runner, raw samples and limits](https://github.com/WireCatLabs/cli-testing/tree/main/performance/search/startup).
  Next compare memo/drive through one-shot CLI and long-lived MCP against the same synthetic corpus; check which
  paths already use `warmEmbedders` before changing lifecycle or store opening.

## CORE-40

- **Where a start goes after `./cli/start`** (2026-10-25, cli-core 0.425.0, Node 24.19, compile cache on). A bare
  `--version` now costs ~60 ms and 52 files. Every other command imports `./cli` (~880 cli-core files, ~400 ms of
  the ~0.6 s a command takes before its own work). In that graph the largest single module whose import, made lazy,
  frees others frees 119 of 1,056 (`shared-command-exports`), then `entities/index` 73, `store/store` 69,
  `services/index` 48: no hub cut pays, as [lazy store and services](https://github.com/WireCatLabs/cli-testing/tree/main/performance/startup/lazy-store-and-services) found too.
- **Mounting only the command being run is not safe.** `config` (permission keys, `permission-keys.ts`), every bot
  command (`bot/context.ts` refuses unknown keys), `envelope.ts`, `steps.ts`, the setup hint in
  `messenger/context.ts` and `conversations` walk the whole command tree.
- **Option A — lazy action bodies, in waves.** The tree stays eager (names, options, help, annotations); each command
  module imports its services, store and entities inside its action. ~60 files that other sessions edit. Acceptance
  per wave: `commands --json` of tg, max and wa byte-identical before and after, and the module count of
  `tg config show --json` going down. Pays only when every builder a tool mounts is light.
- **Option B — a bundle of each tool's `dist`.** esbuild on tg (after tg-cli's mtcute change), one 21 MB ESM file
  with a two-line entry that turns the compile cache on first: medians ~470–575 ms wall and ~600–720 ms CPU against
  ~620–670 ms and ~880–980 ms unbundled, about 100–150 ms wall and 300 ms CPU per command. Costs: `bun:sqlite` and
  `better-sqlite3` stubbed, native addons left outside, asset paths that rely on `import.meta.url`, a second build
  to test. [Numbers and scripts](https://github.com/WireCatLabs/cli-testing/tree/main/performance/startup/fast-start).

## CORE-8

- **One message search without a language switch** — Lucene syntax with legacy's forgiving matching,
  matchers run in parallel, merged and ranked against the query, each hit labelled with how it matched
  (the legacy search and `--language` are already gone). Ranking test set and an owner-approved plan come first. Approved plan for the narrow first step (B):
  [typo-search-default-plan.md](typo-search-default-plan.md).

## CORE-9

- **Generated tags for notes, documents and messages, searchable at once** — claims kept apart from the owner's
  tags, below them in `tag:`, kept as a status on `taggings`; tags in any language with a transliterated form for
  the duplicate check; a model or an agent may set them. Owner: do it all, vectors too (NEED-1005 A).
  Proposal: [generated-tags-plan.md](generated-tags-plan.md).

## CORE-13

- **Serve relay, what v1 leaves out** ([the serve relay](ARCHITECTURE.md#the-serve-relay)): a Windows named pipe
  with an owner-only access list (NEED-1405; off on Windows now); forwarding an `ask` question to the client's
  terminal instead of requiring `--yes`; waiting for a serve that is still starting instead of failing on the
  messenger's own lock; per-watcher buffer budgets for a relayed `watch` (max-cli's `server/subscribers.ts`);
  `mcp --http` through serve; a path type on options instead of the placeholder naming rule (DEBT-124).

## CORE-14

- **One Markdown parser in the messengers** — `parseMarkdownSpans` (`.`) is the shared parser; tg-cli and
  whatsapp-cli switch to it and keep only their renderers. max-cli's dialect differs (`*` italic, `__` bold, `++`
  underline, `^^` highlight, newlines in inline code become spaces) and waits for the owner's call. The legacy
  `parseMarkdown` (`{ text, markup }`, one level deep, used by nobody) goes in the next breaking release.

## CORE-15

- **Messenger feature gaps** — albums, typing and location, MAX cloud password and video
  notes. Proposed, not claimed: [messenger-feature-gaps.md](messenger-feature-gaps.md).

## CORE-16

- **Chat briefs and news digests** — decisions, requests and open questions per chat for a time window,
  and a cited digest of selected news feeds, prepared for the owner's agent. Not designed beyond a
  proposal; needs the owner's scope before a plan.

## CORE-17

- **Mail embedding: what is not measured yet** — a model-based line classifier for cleaning, and a run of
  [bench/mail-quality](../../bench/mail-quality/README.md) on the owner's own mailbox, which would stay in
  cli-private.

## CORE-18

- **A reranker for note and document search, opt-in** — memo and drive only fuse a word list and a meaning
  list, and miss paraphrases (2 of 5 in the top 3 against qmd's 4 of 5:
  [local-documents](https://github.com/WireCatLabs/cli-testing/blob/docs/search-everywhere-and-qmd/performance/search/local-documents/README.md)).
  A query-passage model as a separate download, like `embeddinggemma`, run only in a long-lived process
  (MCP server); never on by default. The message-search rerankers did not ship — the rule one changed
  nothing in the dev sweep, e5 cosine lowered recall, the cross-encoder missed held-out gates at 3–4 s
  ([combined-search.md](combined-search.md)). Measured on the local-documents queries: mmarco (130 MB) lifts
  memo's notes from 0.72 to 0.84 first place and every paraphrase into the top 3, ~2 s a query warm; on Drive
  documents the gain is within noise; qmd's Qwen3 is no better and three times slower
  ([rerankers](https://github.com/WireCatLabs/cli-testing/blob/docs/search-everywhere-and-qmd/performance/search/local-documents/README.md#rerankers-on-these-queries)).
  One run of 25 queries per corpus, no held-out set — the message cross-encoder also looked good on dev and
  failed held-out. Before building: a fresh query set, partly the owner's, run once with the setup frozen.
  Owner (NEED-1004): behind its own flag, off by default; score alone or qmd's blend is decided after the
  second, frozen run.

## CORE-19

- **EmbeddingGemma for documents** — ours already ships it as an option; on documents it was not compared
  with e5-small. Measured together with the reranker; the default for notes changes only on that result.

## CORE-20

- **No query-expansion model** — qmd rewrites each query with a 1.7B model. Our callers are agents that can
  search again in other words; the skills say so. A model for this stays optional and off by default, if ever.

## CORE-21

- **One registry for what gets a vector** — short fields (tag names, titles) and long texts each embedded one
  way; only registry fields get vectors; a test fails on writes around it. Owner direction 2026-10-13.
  Proposal: [embedding-registry-plan.md](embedding-registry-plan.md).

## CORE-22

- **Embedding throughput** — notes, mail and documents embed in one session on `min(8, cores)` threads
  (`src/services/notes-search.ts`), 8 of 24 cores here; one text per `session.run` (`src/embeddings/embed.ts`).
  The worker benchmark split the same 8 threads between workers (1.04–1.1×); more sessions with 8 threads each
  were not measured (two Gemma runs side by side here: roughly 1.3× together, one batch, not a measurement). On
  1,200-character document passages e5-small embedded 11–15 a second and EmbeddingGemma ~1.6, not the 31 and 2
  in the model table. Measure, in order: more sessions over all cores (~700 MB each), batched inputs, a native
  ONNX Runtime (larger install).

## CORE-23

- **Speech throughput** — voice messages are heard one after another, the recognizer is opened and freed for
  each (`src/speech/transcribe.ts` `hearLocally`), on one thread (`src/speech/recognize.ts`). Measure one
  recognizer per pass, then several workers over files (each holds its own model).
