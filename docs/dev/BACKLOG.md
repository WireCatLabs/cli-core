# Backlog

Open work only. A finished item is deleted; its record is the merged pull request.

- **Serve relay, what v1 leaves out** ([the serve relay](ARCHITECTURE.md#the-serve-relay)): a Windows named pipe
  with an owner-only access list (NEED-1405; off on Windows now); forwarding an `ask` question to the client's
  terminal instead of requiring `--yes`; waiting for a serve that is still starting instead of failing on the
  messenger's own lock; per-watcher buffer budgets for a relayed `watch` (max-cli's `server/subscribers.ts`);
  `mcp --http` through serve; a path type on options instead of the placeholder naming rule (DEBT-124).

- **One message search without a language switch** — Lucene syntax with legacy's forgiving matching,
  matchers run in parallel, merged and ranked against the query, each hit labelled with how it matched
  (the legacy search and `--language` are already gone). Ranking test set and an owner-approved plan come first:
  [combined-search-handoff.md](combined-search-handoff.md). Approved plan for the narrow first step (B):
  [typo-search-default-plan.md](typo-search-default-plan.md).
- **One Markdown parser in the messengers** — `parseMarkdownSpans` (`.`) is the shared parser; tg-cli and
  whatsapp-cli switch to it and keep only their renderers. max-cli's dialect differs (`*` italic, `__` bold, `++`
  underline, `^^` highlight, newlines in inline code become spaces) and waits for the owner's call. The legacy
  `parseMarkdown` (`{ text, markup }`, one level deep, used by nobody) goes in the next breaking release.
- **Messenger feature gaps** — albums, archiving, typing and location, MAX cloud password and video
  notes. Proposed, not claimed: [messenger-feature-gaps.md](messenger-feature-gaps.md).
- **Chat briefs and news digests** — decisions, requests and open questions per chat for a time window,
  and a cited digest of selected news feeds, prepared for the owner's agent. Not designed beyond a
  proposal; needs the owner's scope before a plan.
- **Mail embedding: what is not measured yet** — a model-based line classifier for cleaning, and a run of
  [bench/mail-quality](../../bench/mail-quality/README.md) on the owner's own mailbox, which would stay in
  cli-private.
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
- **No query-expansion model** — qmd rewrites each query with a 1.7B model. Our callers are agents that can
  search again in other words; the skills say so. A model for this stays optional and off by default, if ever.
- **EmbeddingGemma for documents** — ours already ships it as an option; on documents it was not compared
  with e5-small. Measured together with the reranker; the default for notes changes only on that result.
- **Generated tags for notes, documents and messages, searchable at once** — claims kept apart from the owner's
  tags, below them in `tag:`, kept as a status on `taggings`; tags in any language with a transliterated form for
  the duplicate check; a model or an agent may set them. Owner: do it all, vectors too (NEED-1005 A).
  Proposal: [generated-tags-plan.md](generated-tags-plan.md).
- **One registry for what gets a vector** — short fields (tag names, titles) and long texts each embedded one
  way; only registry fields get vectors; a test fails on writes around it. Owner direction 2026-10-13.
  Proposal: [embedding-registry-plan.md](embedding-registry-plan.md).
- **Mentions: phones, e-mail, links grouped by site, documents, names and places found in text** — one entity
  with a kind, reviewed by an agent and the owner, linked to people, organizations, documents and places; rules,
  no model, by default. Owner direction NEED-1006 A. Proposal: [mentions-plan.md](mentions-plan.md).
- **Embedding throughput** — notes, mail and documents embed in one session on `min(8, cores)` threads
  (`src/services/notes-search.ts`), 8 of 24 cores here; one text per `session.run` (`src/embeddings/embed.ts`).
  The worker benchmark split the same 8 threads between workers (1.04–1.1×); more sessions with 8 threads each
  were not measured (two Gemma runs side by side here: roughly 1.3× together, one batch, not a measurement). On
  1,200-character document passages e5-small embedded 11–15 a second and EmbeddingGemma ~1.6, not the 31 and 2
  in the model table. Measure, in order: more sessions over all cores (~700 MB each), batched inputs, a native
  ONNX Runtime (larger install).
- **Search start-up** — memo and drive take 1.2–2.4 s a search from the CLI; the same vector search in a warm
  process takes 7 ms, so most of the CLI time is probably start-up and model loading. Measure where the CLI time goes (process start, store open, model load) before tuning search.
- **Speech throughput** — voice messages are heard one after another, the recognizer is opened and freed for
  each (`src/speech/transcribe.ts` `hearLocally`), on one thread (`src/speech/recognize.ts`). Measure one
  recognizer per pass, then several workers over files (each holds its own model).
