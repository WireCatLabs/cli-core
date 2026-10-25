# Plan — one registry for what gets a vector, and how

Status: **proposal, 2026-10-13. Owner direction given, design not approved.** Owner (cli-private journal
`2026-10-13-field-test-followups.md`, IDEA-167): one standard way to embed short fields (tags, titles, names) and
one for long texts (notes, documents, messages); only fields in a registry get vectors; a check enforces it.

## Goal

Every vector in the store is made the same way for its kind of text, from one list that names each field. A new
thing to embed is a registry entry, not a new module with its own queue, chunking and insert. A check fails when
code writes vectors around the registry.

## Current state

Anchors on `origin/main` 8a30bc29, 2026-10-13.

1. **Storage is already shared.** One `chunks` table (`chunkable_type`, `chunkable_id`, offsets, `content_hash`;
   `src/store/sqlite/schema.ts:1568`) and one `embeddings` table keyed by model and content hash
   (`schema.ts:1501-1515`), written in one place (`src/store/sqlite/vectors.ts:189`). Model prefixes come from
   the model list (`src/embeddings/models.ts:25,49,82`).
2. **Writers are not.** Four store modules cut and insert chunks each their own way: conversations
   (`src/services/conversations.ts:108`, `cutChunks`), mail threads and attachments (`src/store/sqlite/emails.ts:472,552`),
   meeting transcripts (`src/store/sqlite/meeting-vectors.ts:203`), notes and documents
   (`src/store/sqlite/note-index.ts:131`, `splitText`). Each has its own "missing vectors" query and its own
   pending queue (`note_index_pending`, `email_index_pending`, `meeting_index_pending`, …).
3. **Short fields have no vectors.** Tag, topic and project names, titles and descriptions are not embedded; the
   vocabulary's meaning check is reserved (`semantic: "not-requested"`).

## Design

### The registry

One module, `src/embeddings/registry.ts`, one entry per embeddable field:

| key | meaning |
| --- | --- |
| `type` | the `chunkable_type`: `conversation`, `note`, `document`, `attachment`, `email_thread`, `meeting_transcript`, `tag`, … |
| `text` | how to read the text of one row (a store query), never copied elsewhere |
| `size` | `short` — one vector for the whole value, no cutting, refused above a limit · `long` — cut by the one chunker (`CHUNK_CHARS`, overlap) |
| `role` | `passage` (searched by queries) or `symmetric` (compared with its own kind: tag to tag) — picks the model prefix |
| `scope` | the account and project columns copied to `chunks` |

- **Prefixes by role:** `passage` texts take the model's passage prefix, queries the query prefix; `symmetric`
  texts take the query prefix on both sides, as the [e5 model card](https://huggingface.co/intfloat/multilingual-e5-small)
  prescribes for semantic similarity.
- **One writer:** `indexVectors(type)` reads pending rows, cuts by `size`, writes `chunks`, finds missing
  `embeddings` by hash, embeds through the pool. The four modules keep their search queries and lose their
  writers.
- **One queue:** `index_pending(type, id)` replaces the per-kind pending tables, each kind moved in one migration.

### The check

- A test lists every `INSERT INTO chunks`, `INSERT INTO embeddings` and `saveVectors(` outside
  `src/embeddings/registry.ts` and `src/store/sqlite/vectors.ts` and fails on any.
- A test runs every registry entry against a small store: a `short` entry yields one chunk, a `long` entry the
  chunker's cut, the prefix matches the role.
- A `chunkable_type` in the store that the registry does not name fails `store doctor`.

## Speed at volume

Search reads only the vectors in its scope (the kind of text, the account, the chat), page by page from SQLite,
and compares each with the query (`nearestChunks`, `src/store/sqlite/vectors.ts:246`). One table for every kind
does not slow it: the cost is the number of vectors in scope, not the table's size. Measured on this machine, 384
dimensions, read in pages of 5,000 as the store does ([cli-testing performance/search/vector-scan](https://github.com/WireCatLabs/cli-testing/blob/docs/gemma-drive-result/performance/search/vector-scan/README.md)):

| vectors in scope | one search, warm |
|---|---|
| 10,000 | 33 ms |
| 100,000 | 0.27 s |
| 300,000 | 0.82 s |

The owner's store holds about 17,400 chunks today. Past about 100,000 in one scope, in this order: keep the vectors
in memory in the MCP server (no page reads), store them as 8-bit numbers (a quarter of the bytes), then an
approximate index. Store version 34 ranks by an exact sqlite-vec index
([search-indexes.md](../storage/search-indexes.md#3--the-scan)).

## No vector column on a main table

A vector never goes into `notes`, `tags` or `messages` as a column, short fields included:

- **A vector belongs to a model.** Two models live side by side (e5-small, EmbeddingGemma); a column holds one.
- **The same text shares one vector.** `embeddings` is keyed by the text's hash: a forwarded message, a copied
  paragraph or a tag name used twice is embedded once.
- **A long text needs several vectors**, one per passage.
- **Main tables stay small.** A 384-number vector is 1.5 kB a row; every ordinary query over that table would read
  it.

A short field is a registry entry of size `short`: one chunk, one vector, in the same two tables.

## Cost

No change to speed expected: the same model, the same chunker, the same tables. The move itself rebuilds no
vectors — `embeddings` is keyed by content hash and survives.

## Phases

1. Registry and the check, with the existing four kinds moved behind one writer; vectors unchanged (the
   `vector-survival` test proves it).
2. `short` entries: tag name and description, topic and project names — what the tag guard's meaning layer needs.
3. One pending queue.

## Open questions for the owner

1. Do titles of notes and documents get their own `short` vector (a title hit ranks apart from a body hit), or stay
   inside the first passage.
