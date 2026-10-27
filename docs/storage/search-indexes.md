# How search works — the indexes, search by meaning, and what each one is for

strict Lucene message search and optional graph/embedding conversation search are implemented. the index-design sections also describe the typo/any-word/substring pipeline of the removed legacy search; of it, the vocabulary still gives `--discover` its typo corrections. The [query-language guide](../search/query-language.md) and [technical specification](../search/query-language-spec.md) define strict syntax, validation, limits and coverage. The semantic-search sections describe the existing separate conversation path. No live account or archive was used for this correction; source inspected at `680d22e`.

## Two searches

| | `messages search` | `conversations search` |
|---|---|---|
| finds | messages | conversations inside a group chat |
| by | strict Lucene words/phrases, Boolean fields and bounded patterns | meaning, and the words it shares, merged |
| needs | stored history and a ready word index for strict text predicates | `conversations links rebuild`, then `conversations embed` |
| runs | SQLite plus bounded validation/pattern checks; no embedding model | a model on this machine (or the user's API key), then a scan |
| MCP tool | `<cli>_messages_search` | `<cli>_conversations_search` |

`messages search` answers "where did someone say X". `conversations search` answers "where did we talk
about X" when nobody used the same words: a question in your own words finds the conversation that
answers it, in the language it was held in.

```text
messages search "gestor valencia"
  parse/validate/scope ─▶ SQLite word/metadata predicates ─▶ strict matching messages

conversations search "кто искал квартиру"
  the model turns the query into a vector ─▶ scan the chunks' vectors ─▶ conversations by meaning ─┐
  the query's words, joined by OR ─▶ messages search (whole words only) ─▶ their conversations ───┤
                                                                     reciprocal rank fusion ◀──────┘
                                                                     ▼
                                                            conversations, best first
```

## The five kinds of index

1. **Filter indexes** — ordinary B-tree indexes: by chat and time, by sender, by account. They make
   `--chat`, `--from`, `--after`, `--before` fast. Always there.
2. **The word index, ranked by BM25** — FTS5 with the `unicode61` tokenizer over `normalized_text`,
   with a prefix index.
3. **The vocabulary** — FTS5 terms for bounded strict wildcard/regex expansion; `--discover` also reads the term/trigram tables for typo candidates.
4. **The substring index** — FTS5 with the `trigram` tokenizer over message text: any three letters
   anywhere. It exists today (migration 5).
5. **Name indexes** — small trigram indexes over chat titles and over people's names and usernames.
   Not over messages.

## 2 · The word index

It works like the index at the back of a book. Each message is normalized — lowercase, accents
removed, ё turned into е — then split into words at spaces and punctuation, and for every word the
index keeps the list of messages that contain it:

```text
gestor    → message 1
valencia  → message 1
tie       → message 4
ptsarev   → message 5      (calendly.com/ptsarev splits into calendly, com, ptsarev)
99812     → message 2      (ab-99812 splits into ab, 99812)
ab45217   → message 2      (no separator: one word)
```

A search for «gestor valencia» looks both lists up and keeps the messages in both. Legacy discovery also tries word beginnings. Strict Lucene needs an explicit wildcard such as `квартир*` for that behavior; a bare term is not silently expanded.

**BM25** orders what was found. For each message it adds up, per search word:

- **how rare the word is** across all messages — «ptsarev» is in few, «en» in almost all, so a match
  on «ptsarev» counts far more;
- **how often the word occurs in this message**;
- **how short the message is** — a short message with the word ranks above a long one where it is
  lost.

No embedding model is needed for this index. Historical index benchmarks measure particular query/storage paths, not a universal end-to-end strict-search latency guarantee.

## 3 · The legacy typo vocabulary

A table of every distinct word in the messages — 38 for the six messages below, 143,501 at 100k
messages (measured). Each word also has its three-letter pieces, indexed, so a typo can be looked up
fast:

```text
valencia → val ale len enc nci cia
whatsapp → wha hat ats tsa sap app
```

A search for «Valenca»:

1. Is «valenca» in the vocabulary? No.
2. Its pieces are `val ale len enc nca`. Which known words share several? valencia (4 shared), and
   others.
3. Keep those at most 2 edits away (an edit adds, removes, changes or swaps one letter). valencia is 1.
4. Search the word index for «valencia».

The vocabulary never searches messages itself; it only turns a typo into a real word.

## 4 · The substring index

It keeps every three-letter piece of every message, so it finds any three or more letters anywhere,
including inside a word. It cannot find fewer than three letters, and ranking over letter pieces is
weak.

## 5 · Name indexes

Answer "which chat or person did you mean": `--chat expats` finds «Valencia Expats», `--from ptsa`
finds «@ptsarev_v»; `contacts search` uses them. Small, and they exist today.

## Scenarios — measured

Run on 2026-09-30 in `node:sqlite` (Node 24) with both FTS5 tokenizers over six messages:

1. «¿Alguien conoce un buen gestor en València?»
2. «Order AB45217 arrived, tracking ab-99812»
3. «Сдаю квартиру в центре, пишите в whatsapp»
4. «Tiempo de espera para la TIE: dos meses»
5. «My calendly.com/ptsarev link for the TV setup»
6. «Entiendo, gracias»

| Search | Word index (2) | Substring index (4) | Who finds it |
|---|---|---|---|
| gestor valencia | 1 | 1 | both; words rank better |
| Valenca (typo) | — | — | **neither — only the vocabulary (3)** corrects it to valencia |
| whatsap (a letter missing) | — | 3 | **substring**; the vocabulary corrects it too |
| квартир (start of a word) | 3 | 3 | both |
| len (middle of a word) | — | 1, 5 (valencia, calendly) | **substring**, with noise |
| 45217 (inside «AB45217») | — | 2 | **substring** |
| 99812 (after a hyphen) | 2 | 2 | both |
| sarev (part of «ptsarev») | — | 5 | **substring** |
| tie | 4 | 4, **6** («en**tie**ndo») | **words**; substring adds noise |
| tv (two letters) | 5 | — | **words**; substring needs three letters |

So: **words with BM25** rank best, bring no noise and handle short words; **the vocabulary** fixes
typos neither index finds alone; **substring** finds fragments — parts of numbers, links, names, the
middle of words — and brings noise.

**Stems** — the store keeps the Snowball stems of every message (`message_stems`), built by
`store migrate`, rebuilt by `store rebuild`, and reported as `stemIndex` by `store info` and
`store check`. The stemmers are chosen for the whole store, not per profile:
`config set search_stemmers.cyrillic russian|none` and `config set search_stemmers.latin <list>|none`.

`search_stemmers.latin` takes several stemmers, comma-separated; `english,spanish` is the default. Each gives its own stem sequence; distinct ones are stored apart
by a separator token (`STEM_SEPARATOR`, `src/search/stem.ts`), and a query matches any of them as a
phrase. A text with Latin words keeps about twice the stems (1.94× on a synthetic fixture). Notes have
the same indexes since store version 1, the initial migration: `note_words`, `note_stems`, and chunks in `chunks` — see
[ARCHITECTURE.md](../dev/ARCHITECTURE.md).

## Search by meaning

Phase 5. Four steps, each a command the owner runs, and nothing leaves the machine unless asked.

### 1 · Conversations, then chunks

`conversations links rebuild --chat <chat>` groups a group chat's messages into conversations — by replies,
mentions and who wrote next (phase 3). The same build cuts each conversation into
**chunks**: consecutive messages, cut only between messages, at most 1,200 characters each (about 300
tokens; `CHUNK_CHARS`, `src/conversations/chunks.ts`). A chunk's text is `sender: text` per line. The
text is never stored — only the chunk's first and last message (`chunk_messages`) and the sha256 of its text
(`chunks`, the table every kind of text is cut into).

**Photos** get a chunk of their own, `chunks.chunkable_type = 'image'` pointing at the attachment: the text is
what the `context` image provider (`src/images/context/`) makes from the photo's caption, up to 3 messages before
and after it in the same chat within 10 minutes (`CONTEXT_MESSAGES`, `CONTEXT_MINUTES`), the chat title and the
sender, and nothing when there is no caption and no such neighbour. The chunk's hash is taken over
`provider:version` and the text, so a newer provider version or a new neighbour gives a new hash and a new vector.
`conversations embed` writes these chunks after the conversation's. A meaning search can return one: the hit is the
photo's message, `matchedIn: "context"`, beside the conversation's own hit. Providers register in
`src/images/registry.ts`; the first that gives an image text describes it.

A photo's **picture** has a second chunk, `chunkable_type = 'image'` at `position = 1` (the context text is position
0), whose hash is the sha256 of the image bytes and whose vector is in `embeddings` under the model key
`local:clip-b32:512`, written by `images embed` for profiles with `picture_search` on. Position 0 and 1 never mix:
`saveImageChunks` replaces position 0 alone, and a picture search reads position 1 alone. The vector of a deleted
message's picture is dropped on the next `images embed`.

A document that is an image has one chunk, `chunkable_type = 'document_picture'` at `position = 0`, built the same way
(hash = sha256 of the bytes, vector under `local:clip-b32:512`). The text index never reads it: it reads
`document` and `note` chunks alone. Soft-deleting the document drops it with the document's text chunks.

Why chunks and not whole conversations: e5-small reads at most 512 tokens (EmbeddingGemma 2,048), and
one long conversation covers many subjects. Why not single messages: «ок» or «да, давай» mean nothing alone.

### 2 · Vectors

`conversations embed --chat <chat>` gives every chunk of the current build a **vector** — 384 numbers
for e5-small — that places texts of similar meaning near each other. Vectors live in `chunk_vectors`,
keyed by **model and text hash**, not by chat or conversation:

- a rebuild writes new conversation rows, but a chunk whose text did not change has the same hash and
  finds its vector again — nothing is embedded twice;
- the same text in two chats has one vector;
- two models never mix — e5-small, EmbeddingGemma and an API model each keep their own.

The run resumes where it stopped, and `embed status` says how many chunks are left and how long they
should take. A chunk whose messages changed after the build waits for the next build.

**The models** (`models list`, downloaded once into a folder every messenger CLI shares):

| model | vector | size | languages | speed here |
|---|---|---|---|---|
| **e5-small** (default) | 384 | ~135 MB | ~100, Russian and English among them | ~31 chunks/s |
| EmbeddingGemma | 768 | ~220 MB | 100+, better on chat | about 7× slower |
| an API: OpenAI `text-embedding-3-small`, or any server with OpenAI's `/v1/embeddings` (`--base-url`) | the model's | — | the model's | the API's |

They run in ONNX Runtime 1.30.0 (`@wirecat/cli-core-onnx`), on Node and Bun alike:

- **Native** on Linux x64 and arm64 (glibc) and macOS arm64, 2–3× faster. `models download` of a text model or
  reranker also fetches Microsoft's release archive of the library for the system (10–42 MB, checked by sha256),
  and places the library beside a copy of the binding `@wirecat/cli-core-onnx` carries, in
  `models/runtime/onnxruntime-1.30.0-<system>/`. A search never downloads it.
- **WebAssembly** everywhere else — Windows (its binding needs the DirectML build of `onnxruntime.dll`, not in
  Microsoft's release), Intel Macs, musl — before that download, and whenever the native library does not load or
  will not open a model. Picture models (CLIP, SigLIP2) take the same path.

The two give slightly different numbers for the same text (8-bit kernels differ); vectors built by one search well
with questions embedded by the other. An API model needs the user's key (`models keys set`), says
how many chunks, tokens and dollars at most before chat text leaves the machine, and waits for a yes.

e5-small is weak across languages: an English chat did not answer the same question asked in Russian.
EmbeddingGemma does better.

### 3 · The scan

`conversations search "<query>"` turns the query into a vector with the same model and keeps each
conversation's best chunk by **cosine** — how close two vectors point, from −1 to 1; vectors are stored at length
one, so it is a plain dot product.

**The vector index** (store version 34, `src/store/sqlite/vector-index.ts`). Each embedding model has a sqlite-vec
`vec0` table in the store, `vector_index_<id>` (listed in `vector_indexes`): one row per chunk with a vector of that
model, rowid `chunks.id`, the chunk's hash beside it. `kind` (the chunk's type) and `account` are partition keys,
`chat` and `occurred_at` metadata, so a KNN query filters on them before it ranks — exactly, since sqlite-vec 0.1.9
compares every vector in the partition (no approximation). Triggers on every column the index derives a row from —
`chunks`, `embeddings`, `messages` (chat, send time), `attachments` (which message), `conversations` (which chat) and
`chats` (which account) — pass each changed chunk through `vector_index_redo`, and each model's trigger re-derives that chunk's row, in the same
transaction as the write — whoever writes, including the schema's own delete triggers. A store that held vectors
before version 34 is filled on its first writable open, in short batches; until a model's index is `ready` its
searches scan.

A search takes the nearest candidates from the index, runs the scan's own SQL on just those (hidden chats, deleted
messages, old builds, the hash, so a reused chunk id is never taken for the old chunk), scores them with the same
dot product, and asks vec0 for more (up to its limit of 4,096) until enough survive. When even 4,096 leave too few,
or a filter the index cannot express is set (a person, a project, a scope, a list of conversations), the search
scans: SQLite reads 5,000 rows at a time in the chunks' key order, and JavaScript does the arithmetic
(`nearestChunks`, `src/store/sqlite/vectors.ts`). Messages (`nearestMessages`) and images (`nearestImages`) search
the same way. Mail, notes, meeting transcripts and document pictures still scan. `store check` compares each ready
index's rows, whole, with the rows its sources give now, both ways.

Vectors are stored at length one (`saveVectors` scales them), so the index's cosine and the scan's dot product rank
alike; vec0 measures in float32, so a result counts as settled only when it is nearer than the last candidate by more
than 1e-5.

Every store connection loads the extension (`src/store/vector-extension.ts`); without it the store does not open.

A chat embedded only with another model cannot be searched by meaning with this one: the search names
it on stderr and in a `missing` entry with the `conversations.embed` step, instead of leaving it out silently.

**Freshness.** Both indexes change only when the owner runs `conversations links rebuild` and `conversations embed`
— nothing runs on sync.
`conversations status` (MCP `conversations_status`) shows, per built chat, the messages the build has not seen
— new and deleted ones by the build's membership, edited ones by their revision's time — and the chunks whose
vector is current, stale (a message in it changed after the build) or missing. A changed sender name leaves no
trace there. The search answers the same as `missing` entries — chats searched by words only or in part, chats
changed since the build or never built — each with the step that fixes it (`conversations.embed`,
`conversations.build`), and `models.download` when the model is not downloaded.

**Catching up** (NEED-551 A). Without `--chat`, `conversations links rebuild` rebuilds every built chat that changed
since its build (or whose rules are older), the oldest build first, then builds the group chats never built,
the newest message first; `conversations embed` embeds the chunks left in every built chat. Each run does at
most `--max-chats` chats (20) and embeds at most `--max-chunks` chunks (2,000, about a minute with e5-small);
the next run goes on from there, and `left` in the JSON names what is still to do. `conversations search
--catch-up` runs both, for its scope, before it searches; MCP `conversations_refresh` does the same, at most 500
chunks a call so a client does not give up on it. Only the model on this machine embeds this way:
`--embedding-provider` and `--base-url` are refused, a model is never downloaded, and with none downloaded the build
still runs and nothing is embedded. Dialogs, channels and chats of unknown kind (a chat seen only through its
messages, never listed) are built only when named with `--chat`.

Before a meaning hit is returned, the search reads its chunk's messages again and hashes them as `embed` does.
A chunk whose text changed is still returned, with `stale: true` (NEED-550 B); one holding a deleted message
is dropped. Deleting a message also deletes the vectors of the chunks that held it, of every model, unless a
current chunk with no deleted message still uses the same text (NEED-393: a deletion leaves no text behind).

### 4 · Meaning and words, merged

Meaning misses a rare exact word — a name, a reference number, «empadronamiento» — and words miss a
paraphrase. So the same command also runs `messages search` over the query's plain words, joined by
`OR` (nothing in the original question is read as a filter), and maps matching messages to their conversations. Under the current strict default these are whole-word matches; automatic prefix/typo/substring discovery is not added to the word branch. The two lists merge by **reciprocal rank fusion**: a conversation scores
1 / (60 + its rank) in each list it is in, and the sum orders the result. At least 50 semantic candidates (or the requested limit when larger) and the conversations of up to 200 word-matched messages take part.

Each result says how it was found:

```json
{ "summary": { "id": "656", "firstMessageId": "1640", "messageCount": 7, "…": "…" },
  "chunk": { "firstMessageId": "1640", "lastMessageId": "1707" },
  "score": 0.835,
  "by": ["meaning", "words"],
  "stale": false }
```

`score` is the meaning's cosine, `null` when only words found the conversation. A built chat that was
never embedded can still be found by its words. When the local model is not downloaded, the search answers by
words alone, says `meaning: "unavailable"` and names `models download` on stderr (NEED-552 A); it never
downloads a model or calls a remote one in its place. A remote model that fails is still an error.

### Notes and documents: a title match comes first

`search notes` (and the notes inside `search all`, and `drive search`) merge words and meaning the same way, with one
exception. When the query is only words or quoted phrases, notes whose title equals the query come first, then notes whose
title contains it as a phrase, then notes whose title holds all its words in any order (compared without case or
accents), each group in its word order. They are followed by the merged list without repeats, and `found_by` lists
`title` for them. A query with a field, `OR`, `NOT`, a wildcard, a regex or a group is merged as before.

### Related to a message

`conversations related <chat> <message>` (MCP `conversations_related`) answers "what else was like this":
the conversations nearest in meaning to the one the message is in, in every built chat, never that one. The
query is the mean of that conversation's vectors, made unit length again — only the vectors of chunks whose
messages did not change since the build, so an edit or a deletion is not searched as it was. No model runs:
it works with none downloaded. It answers the same `readiness` as the search, and refuses with `conversations links rebuild` (the chat changed)
or `conversations embed` (no vector) when the conversation has no usable vector. It has no `--chat` scope yet:
the source is already `<chat>`, and a second chat option needs a name of its own.

### In the MCP server

A one-shot command loads the model (~1 s), searches and exits. The MCP server keeps the model between
calls (`warmEmbedders`, `src/embeddings/embed.ts`), so a search after the first pays only the scan.
The kept
model runs in a child process of its own, on Node and Bun alike, and the process ends after 10 minutes
without a search; the next search starts it again (~1 s). The server itself stays near its starting size.

| measured 2026-10-02, three load-and-close cycles | memory left after each close |
|---|---|
| the model in a child process (what runs) | none — the server stays at 52–64 MB, Node and Bun |
| Node, the model in a worker thread | ~0.2 GB each time, from ~1 GB loaded |
| Node, the model in the same thread | ~0.8 GB — closing the session alone frees ~0.1 GB |
| Bun, a worker thread or the same thread | grows 0.2–0.55 GB a cycle |

A request travels as one line of JSON each way (`src/embeddings/process.ts`, `child.ts`); a warm query
takes 7–14 ms of it. A child whose server is killed sees its input close and exits.

Vectors are not kept in memory: `embed` and `build` run in other processes, and a copy in the server
would go stale.

### Measured at 100k messages

One group chat of 100,000 synthetic messages in three languages, 42,417 chunks, a 24-thread laptop
([bench/embeddings](../../bench/embeddings/README.md)):

| step | time |
|---|---|
| `conversations links rebuild` | 3.3 s |
| `conversations embed`, e5-small | ~22 min, Node or Bun; 3 worker threads gained only 1.04–1.1×, so there are none |
| `conversations search`, one-shot | ~1.4 s (model load ~1 s, then the scan) |
| `conversations search` in the MCP server | ~0.35 s |
| of which the word search | ~25 ms |

Before the scan read the chunks in their key order, SQLite sorted every vector for each 5,000-row page,
and the MCP search took 1.4 s.

### Where it lives

| what | where |
|---|---|
| cutting chunks, their text and hash | `src/conversations/chunks.ts` |
| the model list | `src/embeddings/models.ts` |
| running a model: in this thread, or kept warm in a child process | `src/embeddings/embed.ts`, `process.ts`, `child.ts` |
| download, with sha256, into the shared folder | `src/cli/messenger/models-command.ts`, through `src/speech/install.ts` |
| an API model | `src/embeddings/remote.ts` |
| embed, status, readiness, refresh, clear | `src/services/embeddings-maintenance.ts` |
| search, related, the merge | `src/services/embeddings-search.ts` |
| the vector tables and the scan | `src/store/sqlite/vectors.ts` |
| the vector index | `src/store/sqlite/vector-index.ts`, `src/store/vector-extension.ts` |
| the commands | `src/cli/messenger/conversations-command.ts` |
| the MCP tools | generated from the commands (`src/mcp/agent.ts`) |


## Conversation quality and cosine floor

Hybrid `conversations search` filters cosine before reciprocal rank fusion: local e5-small at 384
dimensions requires score >0.80; unmeasured models require positive cosine. Word-only matches remain
eligible. The floor is calibrated on dev queries and evaluated on a synthetic held-out set, with
noise reduced at a small recall cost; it does not make scores probabilities or prove relevance.
`conversations related` retains neighbour-lookup semantics. Reproduce the scores and the 1M-vector
scan with [the quality benchmark](../../bench/search-quality/README.md). The exact scan is sufficient
at the measured smaller scale; ≥300k eligible chunks demonstrate the need for ANN under a proposed
one-second scan budget. The vector index (store version 34, above) is the answer to that.
