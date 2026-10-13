# Backlog

Open work only. A finished item is deleted; its record is the merged pull request.

- **One message search without a language switch** — Lucene syntax with legacy's forgiving matching,
  matchers run in parallel, merged and ranked against the query, each hit labelled with how it matched;
  removes `--language legacy`. Ranking test set and an owner-approved plan come first:
  [combined-search-handoff.md](combined-search-handoff.md). Approved plan for the narrow first step (B):
  [typo-search-default-plan.md](typo-search-default-plan.md).
- **Messenger feature gaps** — albums, archiving, typing and location, MAX cloud password and video
  notes. Proposed, not claimed: [messenger-feature-gaps.md](messenger-feature-gaps.md).
- **Chat briefs and news digests** — decisions, requests and open questions per chat for a time window,
  and a cited digest of selected news feeds, prepared for the owner's agent. Not designed beyond a
  proposal; needs the owner's scope before a plan.
- **Mail embedding: what is not measured yet** — a model-based line classifier for cleaning, and a run of
  [bench/mail-quality](../../bench/mail-quality/README.md) on the owner's own mailbox, which would stay in
  cli-private.
- **Google Drive documents in the one store** — drive-cli writes into the shared store so `search all`
  finds Drive documents; approved, not built: [drive-in-store-plan.md](drive-in-store-plan.md).
- **Documents linked in a chat** — `chats documents list <chat>` and `store.notes.linkMessages` are built
  here; tg and max still pin a release with them, and drive's `sync` still adds the two link passes:
  [chat-documents-plan.md](chat-documents-plan.md).
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
  Open: score alone (better first place) or qmd's blend (never loses an exact hit).
- **No query-expansion model** — qmd rewrites each query with a 1.7B model. Our callers are agents that can
  search again in other words; the skills say so. A model for this stays optional and off by default, if ever.
- **EmbeddingGemma for documents** — ours already ships it as an option; on documents it was not compared
  with e5-small. Measured together with the reranker; the default for notes changes only on that result.
- **Tags an agent proposes for notes and documents** — an agent suggests tags, recorded with the agent as
  author and pending the owner's confirmation (that separates the owner's tags from generated ones), and
  `search all` matches them. A new tag goes through the vocabulary's preflight, which compares letter pairs
  today; add, cheapest first: word stems, edit distance against the vocabulary (the typo corrector's code),
  transliteration, tags that sit on nearly the same items, and the `semantic` check the vocabulary already
  reserves. New verbs go to STANDARD first.
- **Values pulled out of text** — phone numbers, e-mail addresses, URLs and their domains, document ids,
  normalized and indexed as fields (`phone:`, `email:`, `domain:`) because plain text search misses a value
  written another way (`+7 921…` against `8921…`), and because they link people and documents across
  sources. Headings of notes and documents, so a hit names its section. Not addresses or names by pattern:
  people are linked by the agent with confirmation, as tags. Needs a plan and the owner's choice of fields.
- **Embedding throughput** — one text per `session.run` (`src/embeddings/embed.ts`), up to 8 WebAssembly
  threads; extra workers measured 1.04–1.1×. On 1,200-character document passages e5-small embedded 11–15 a
  second and EmbeddingGemma ~1.6, not the 31 and 2 in the model table. Measure batched inputs first; a native ONNX Runtime is the larger lever at a larger install.
- **Search start-up** — memo and drive take 1.2–2.4 s a search from the CLI; the same vector search in a warm
  process takes 7 ms. Measure where the CLI time goes (process start, store open, model load) before tuning search.
- **Speech throughput** — voice messages are heard one after another, the recognizer is opened and freed for
  each (`src/speech/transcribe.ts` `hearLocally`), on one thread (`src/speech/recognize.ts`). Measure one
  recognizer per pass, then several workers over files (each holds its own model).
