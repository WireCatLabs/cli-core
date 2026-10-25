# Storage and search — rulings in force

The owner's requirements are [`requirements.md`](requirements.md). These are the storage and search
rulings that hold today; the id in brackets is the owner's ruling in max-cli's private journal.

- **Drizzle** is the way to work with the database — schema, queries, generated migrations.
- **The store API is async**, "fully async where we can".
- No Elasticsearch, OpenSearch, LanceDB or graph database in the initial architecture (requirements §2, §12).
- **Engine: SQLite FTS5**, built behind a store interface a Postgres backend could implement later (NEED-374 A).
- **Search requires every word, and falls back to any word when nothing is found** (NEED-375 A). **BM25 ranks, trigram typo matching corrects**: a word the corpus knows is used as typed; an unknown word gets candidates from a trigram index over the vocabulary, edit distance ≤ 2, and the search runs with the corrections (as in `bench/search/sqlite.ts`).
- **Keep the substring index over message text** (FTS5 `trigram`, as migration 5) next to the new word index: words with BM25 first, substring when words and typo correction find nothing.
- **A migration that drops what an older build reads raises `min_compatible`**, so that build refuses the store file and asks to be upgraded; tg-cli and max-cli ship their upgrade the same day. It is 1 today.
- **Column names stay as they were** where §4–§5 of the requirements name the same field differently: a rename rebuilds the table, and a rebuild breaks every build already installed. The mapping is under [Names](#names-the-requirements-field-and-the-column-that-holds-it).
- **No messenger-only tables.** What max-cli's cache needs and Telegram has too becomes a generic table (versions 7–11: chat members, sync state, fetch leases, contact recency, transcripts); the rest goes into `provider_metadata`.
- **No daemon that owns the database, now or later.** `max serve` stays what it is — the daemon for MAX API requests — and does not become the database's owner. **Background workers are planned** for long jobs (sync, graph building, AI enrichment), from phase 3 on: they open the store like any command. See `daemon.md`.
- Ordinary search never calls an API; AI enrichment only on explicit request, with cost limits (requirements §3, §14, §15, §29).
- **The CLI never calls an AI model to link messages. The user's own agent does it**, through a skill and CLI commands, only when the user asks: the CLI builds the free links (replies, threads, one sender's consecutive messages), hands out overlapping batches with candidate links, stores the links the agent returns with their source and model, then builds conversations, chunks and embeddings. Supersedes requirements §13 stage 3, §14 `--mode ai`, §15 cost estimates and §27 `ConversationInferenceProvider` (NEED-405). Owner:
- **Embeddings are computed locally**, by one small multilingual model, or a short list to choose from, in the folder the speech models already share between tg and max (`~/.local/share/WireCat/models/`, `src/speech/install.ts`). Embeddings go on chunks, not on single messages, and are not used to link messages (NEED-412 A).
- **Phase 5: e5-small is the default embedding model**, EmbeddingGemma in the list for whoever accepts the Gemma terms (NEED-517 A); vectors in a plain table scanned in JS, not sqlite-vec, until a real archive outgrows it (NEED-518 A) — **replaced: vectors are ranked by a sqlite-vec `vec0` index per model inside the store, kept in step by triggers, with the extension shipped in `@wirecat/cli-core-sqlite`** (owner, 25.10, cli-core#<this PR>); **the model runtime ships as our own small package** (`@wirecat/cli-core-onnx`), nothing imported from the models folder (NEED-519 A). Plan.
- **Embeddings may also come from an external API, with the user's own key**, on top of the local default — amends NEED-412 A; and **embedding runs in parallel** to go faster. Owner:
- **The substring index ignores accents, as the word index does**, so `len` finds "València": `messages_fts` is rebuilt as FTS5 `trigram` over `normalized_text` (or with `remove_diacritics 1`), and the substring query is normalized the same way. It goes into the same migration as phase 5's store version 14, so a user waits through one rebuild, not two (max-cli NEED-521 A, from FIND-443). Phase 5 plan E8. version 14 shipped in 0.99.0 without it, hours after this ruling, so the rebuild rides on the next store version that is needed anyway, still one rebuild, not one of its own.
- **Phase 2 search takes a typed query language** — `from:` `chat:` `after:` `before:` `has:`, `"phrase"`, `-word`, `OR` — mapped onto the filters and FTS5, **and shows how complete the archive is for each chat searched**, from `sync_ranges` (NEED-400 A). **Refined 2026-10-01 (NEED-455 A):** from three facts — the newest message held against the chat's newest, gaps in `sync_ranges`, and a `sync_state` note that `store fetch` reached the chat's start.
- **Phase 2's word index is finished in pieces by `search messages` itself** (up to ~200 ms a call, normalization first) as well as by `store migrate`, so a max user without tg gets it before the fold-in.
- **Index maintenance lives under `store`**: `store info`, `store check` and `store reindex` (requirements §23's `search status|rebuild`).
- **Phase 2 searches across accounts and messengers on request**: `in:telegram` / `in:max` / `in:all` and `--source` read every such account held in the store (`wirecat.db`); the default stays the current account.
- **A chat the account left is marked, not deleted, and `store clear --left` deletes the marked ones** with their messages, members and sync state (max-cli NEED-488 B, NEED-496 B). The command is shared; tg gets it with store version 14, max with the other store maintenance commands at the fold-in — until then `max cache clear --left`. It asks for `--allow-dangerous`, as `messages delete` does: what it deletes cannot be fetched again. Plan: `plans/chats-left.md`. max got `store clear` with the maintenance commands, in group 6 (max-cli #307), since its left chats' messages live in the store from then on; `max cache clear --left` still clears the old cache. Open for the owner: NEED-510.
- **`store check` also reports completeness per chat**: chats whose history does not reach their newest message, and how long ago each chat was refreshed; plus `PRAGMA foreign_key_check`.

## Names: the requirements' field and the column that holds it

Only the fields whose name differs.

| Requirements (§4–§5) | Column |
|---|---|
| `messages.id`, `chats.id` | `pk` |
| `source` | `accounts.provider`, through `account_pk` |
| `source_message_id`, `source_chat_id` | `native_id` |
| `account_id`, `chat_id`, `sender_id` | `account_pk`, `chat_pk`, `sender_identity_pk` (+ `sender_chat_native_id`) |
| `reply_to_message_id` | `reply_to_native_id`, the provider's id; a link to our own row is phase 3 |
| `forward_source` | `forward` (JSON) |
| `created_at`, `updated_at` | `ingested_at`, `edited_at` |
| `raw_metadata` | `provider_metadata` |
| chat `name`, `type` | `title`, `kind` |

Not stored: `quoted_message_id` and `topic_id` (phase 3; `thread_native_id` exists),
`first_message_at` and `last_message_at` (an index lookup over `messages_by_time`; the chat's
`last_message_at` column is the provider's value), `last_indexed_at` (phase 2, with its index).
