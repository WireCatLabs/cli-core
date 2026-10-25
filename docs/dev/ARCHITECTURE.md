# Architecture

What the package is made of and where the seams are: the map of what exists. Open work is in
[the backlog](BACKLOG.md).

## The one rule

**Nothing here knows a messenger.** A CLI's adapter translates its provider's objects into the
domain types, and `biome.json` refuses any import of `@mtcute/*`, `ws` or an adapter directory
under `src/`. What only one provider has travels in `providerMetadata`.

## Responsibility and dependency boundaries

Follow the shared
[modularity standard](https://github.com/WireCatLabs/cli-base/blob/main/docs/dev/MODULARITY.md).
cli-base owns framework primitives; cli-core owns provider-neutral domain behavior and use cases;
provider applications own vendor translation and account/resource binding.

| Module | Responsibility |
|---|---|
| Domain modules such as `src/meetings/` and `src/tasks/` | Models, references, validation and capability ports; no transport runtime or SQL implementation |
| `src/persistence/native/` | Native recording partial storage and publication recovery over meeting ports and ordinary-file helpers; hosts choose layout, codecs and limits ([partials](NATIVE-RECORDING-PARTIALS.md), [publication](NATIVE-RECORDING-PUBLICATION.md)) |
| `src/files/` | Ordinary-file validation and native writer leases behind narrow ownership contracts; hosts supply archive layout ([guide](FILE-LEASES.md)) |
| `src/services/` | Use-case orchestration over injected narrow ports; no provider SDK or concrete store imports |
| `src/store/sqlite/` and store drivers | Persistence adapters, SQL and transaction boundaries |
| `src/cli/`, `src/mcp/`, domain `/cli` and `/mcp` entries | Transport parsing and result presentation; call shared policy rather than copying it |
| Provider application's composition root | Choose account, bind store and provider ports, enforce lifetime and close-before-output |

Persistence adapters are part of Core; vendor adapters are not. Keep this distinction when adding
meeting providers. A service may depend on an exported store contract without importing its SQLite
implementation. New CLI/MCP capabilities share validation, account-bound reader contracts and answer
mapping. Split substantive orchestration, transport parsing and formatting into coherent modules;
do not grow an existing handler into a second service layer. These boundaries are review rules;
existing import restrictions and type checks enforce only the subset configured in the repository.

## CLI design references

The command interface follows a shared [adoption profile](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-28--use-the-external-command-line-references-as-a-baseline-and-keep-the-projects-choices-where-they-differ):
[POSIX utility conventions](https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap12.html)
for utility syntax, [GNU CLI conventions](https://www.gnu.org/prep/standards/html_node/Command_002dLine-Interfaces)
for common options, and [CLIG](https://clig.dev/) for modern CLI design. The standard records our
additional agent contract and deliberate differences. These references do not choose a particular
resource hierarchy; `stats` is a project decision.

The shared program shell owns parsing and error routing; the renderer owns machine output;
command discovery describes the tree; services own use cases and write guards enforce permissions.
CLI and MCP are two adapters over those services. The [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
governs the latter; [Agent Skills](https://agentskills.io/specification) describes the portable
agent guidance format. Agent-oriented design references and their applicability are linked from
the standard, so a reader need not treat a project example as a formal standard.

The [compliance audit](CLI-COMPLIANCE.md) distinguishes source evidence, isolated observations,
intentional deviations and work still needed. This architecture page does not certify complete
conformance or imply that planned command paths are already implemented.

## Modules

The optional [bounded context reader](CONTEXT-EVIDENCE.md) reads explicitly selected local
messages, mail and imported documents without index/model work. It is a shared SDK foundation;
meeting preparation includes communications only through explicit host-captured selections.
The project-candidate SDK separately matches bounded host-supplied evidence against existing project
names, keys and aliases; it neither reads other meetings nor confirms membership.
[Project evidence gathering](PROJECT-GATHERING.md) plans bounded reads of those context readers across
alias, keyword and person lanes and returns cited evidence with a resume checkpoint; it writes nothing.

| Export | Directory | What it holds |
|---|---|---|
| `.` | `src/domain/`, `src/render/`, `src/resolve.ts`, `src/terminal/` | the domain model (`models.ts`, types only), message locators, message rendering, name resolution that refuses rather than guesses, the secret prompt, the terminal QR code |
| `./documents` | `src/documents/`, `src/services/documents/` | Provider-neutral file contracts, scoped ingestion/sync, document knowledge and evidence-backed extraction; existing readers remain available — see [Document workflows](DOCUMENTS.md) |
| `./store` | `src/store/` | the SQLite seam and the shared message store |
| `./sends` | `src/sends/` | the send guard: the permission levels, the read-only lock, the recipient list, the hourly limit, the journal (never the text), the send id |
| `./speech` | `src/speech/` | the pinned catalogue, shared model directories, verified installer and installed-only bounded PCM recognizer; import alone loads no engine |
| `./charts` | `src/charts/` | neutral chart data and a replaceable renderer interface; SVG rendering loads ECharts only on demand; a separate lazy PNG encoder uses resvg and bundled fonts |
| `./models` | `src/models/` | purpose-specific text generation with typed image inputs, OpenAI-compatible and Anthropic adapters, strict options, injected key/consent resolvers; no configured provider means no call |
| `./services` | `src/services/` | the use cases, once each, that commands and MCP tools call — see [Services](#services) |
| `./background` | `src/background/` | what any background process needs and no messenger: the lock per app and profile, whether a PID is alive and ours, the machine seam tests replace, systemd and launchd units — `serve` and `server` are built on it, each CLI's server stays its own (NEED-492 C) |
| `./cli` | `src/cli/`, `src/mcp/` | the command skeleton, the shared commands and the MCP server |
| `./cli/start` | `src/cli/entry.ts` | `startCli` without the barrel: about 50 files where `./cli` loads about 1,000, checked by `check:dist`; a bare `--version` never loads the program |
| `./sqlite-runtime` | `src/sqlite-runtime.ts` | `ensureSqlite`, the first thing `tg` and `max` run: restarts the command with the bundled SQLite when the system's lacks FTS5 — see [The store](#the-store) |
| `./parity` | `src/parity/` | the command manifest, page and wording checks behind `cli-core-parity`, which compares `tg` and `max` |
| `./testing` | `src/kit/` | the adapter kit: a fake adapter, the contract cases and their seed — see [the adapter guide](ADAPTERS.md). `src/testing/` is this repository's own test setup and is not published |
| `./tasks`, `./tasks/testing` | `src/tasks/` | open tasks: model, `TaskStore` port and service — see [Open tasks](#open-tasks) |
| `./meetings`, `/meetings/cli`, `/meetings/mcp`, `/meetings/testing` | `src/meetings/` | events and meetings, the provider and store ports, pull, import, commands and MCP reads — see [Meetings](MEETINGS.md) and [provider integration](MEETING-PROVIDERS.md) |

The README's table lists what each export offers; this page does not repeat it.

## The store

[Read-only store opening](STORE-OPENING.md) separates native read-only handles and existing-schema
checks from the ordinary opener's maintenance, while reusing the same lazy store adapters.

`openCache` (`src/store/open.ts`) opens `node:sqlite` under Node and `bun:sqlite` under Bun. Both
imports are dynamic: a static import of the other runtime's module fails at load time, before
anything can catch it. `pnpm smoke:bun` is what proves the Bun half.

Before it opens the file, `openStore` checks once per process that the runtime's SQLite has the
full-text search the migrations need (`assertStoreCapable`), and refuses with what to install. The
version number does not tell: official Node 22.0–22.15 has SQLite 3.46–3.49 without FTS5. Full validation runs the
built package on Node 22.15.0 to see the refusal (`scripts/check-old-node.mjs`).

Where the runtime's SQLite can be swapped, ours from `@wirecat/cli-core-sqlite` (built in
`packages/sqlite`, published by `.github/workflows/sqlite.yml`) takes its place
(plan):

- **Bun on macOS** always loads ours (`bunDatabase`, `src/store/drivers/bun-sqlite.ts`), once, before
  the first database: Bun uses the system's library there, which can be too old.
- **A Linux distribution's Node** links the system's `libsqlite3`. `ensureSqlite`
  (`src/sqlite-runtime.ts`, exported as `@wirecat/cli-core/sqlite-runtime`) is the first thing
  `tg` and `max` run: when the system's SQLite fails the check above, it starts the command again
  with ours first on `LD_LIBRARY_PATH`, before anything is read or sent. Full validation runs it on Ubuntu's Node
  with SQLite 3.42 (`scripts/check-sqlite-restart.mjs`).
- Official Node and Bun on Linux and Windows build SQLite in; nothing is swapped.

`openStore` (`src/store/store.ts`) is the **one file for every messenger and account** — tg's
profiles and max-cli's bots write the same database, keyed by provider and account. Its path comes
from `storePath` (`src/store/path.ts`), the only place that turns `MESSAGING_STORE` into a path. Without it the file is `wirecat.db` in the WireCat folder (`~/.local/share/WireCat/`, `%LOCALAPPDATA%\WireCat\Data\`; `WIRECAT_STATE_DIR` moves the folder, the models live in its `models/`).
`mcp config` copies the variable into the entry it prints, so the server it starts opens the same file.

Every `MessageStore` method is async and is **one whole operation**: inside the SQLite store each
write runs as one synchronous `BEGIN IMMEDIATE` transaction, with no `await` between `BEGIN` and
`COMMIT`. The interface has no `transaction(callback)`. The driver is synchronous, so an `await` inside a
transaction would let the commit run before the awaited part; and since a method never yields
mid-transaction, two calls on one store in `serve` or `mcp` cannot interleave inside one `BEGIN`
(phase 1 plan, D3). A large write therefore
blocks the event loop while it runs — keep writes in bounded batches.

**One method is several transactions on purpose:** `replaceConversations` (phase 3). A chat of 1M
messages takes seconds to write, and every other process waits at most 5 s for the lock, so it writes a
new **build** of the chat's links and conversations in transactions of ~250 ms with a 120 ms pause
between them, makes the build current in one more, and drops older builds the same way. Each
transaction runs synchronously to its `COMMIT`; the pause is between them. Readers see only
`conversation_state.current_build`, so a half-written or failed build is never read. Without the pause
the next `BEGIN IMMEDIATE` wins the lock again at once and a waiting process sees no gap
([`bench/disentangle/`](../../bench/disentangle/README.md), plan
phase 3, C3).

**The user's agent links what the rules leave open** (phase 4, plan). The CLI
never calls a model ([NEED-405](../storage/decisions.md)); it hands the agent batches and stores its
answers, in `src/store/sqlite/batches.ts`:

- **A batch** is the earliest live message that needs the agent — no reply the messenger records, no
  current agent answer — and the next `--size` live messages, plus `BATCH_CONTEXT` (50) messages before
  it as context. The rules' current links come along as candidates. No table holds batches.
- **The batch id** (`batchId`) names the chat, the first and last message to answer, and a hash of every
  live message between them. `links add` reads that span again and refuses the answer when the hash
  differs: a message added or deleted inside it means the agent answered a window that moved. Answering
  some of its messages leaves the id valid.
- **An answer is checked whole before anything is stored** (`saveAnswers`): every message one the batch
  asks about, each parent in the batch and earlier than its message, no message twice, confidence 0–1, a
  model named. One refusal stores nothing. A message's new answer replaces its earlier one; the rows are
  `message_links` with `source = 'agent'`, outside any build, so a rebuild keeps them. An answer goes
  stale when its message or parent changes after it was written, and the message needs the agent again.
- **The choice** (`choose`, `src/conversations/link.ts`): the messenger's reply, then a fresh agent
  answer — including "starts a conversation", which drops the rule's parent — then the most confident
  rule. An answer naming a message the chat no longer holds leaves the choice to the rules.
- **Permission**: `conversations links` has its own key, `conversations.links` (`keyForCommand`,
  `src/sends/permissions.ts`), so a profile read-only on messages can still link — the answers write
  only to the local store. `batches next` shows message text and is checked as `messages`.

**Chunks and vectors** (phase 5, plan). Each build
also writes `chunks` rows of type `conversation`, with their message range in `chunk_messages`: a conversation cut at message boundaries into pieces of at most
`CHUNK_CHARS` (`src/conversations/chunks.ts`), each with its first and last message and the sha256 of
its text. A message longer than a chunk is split into overlapping pieces (`splitText`), a chunk each, and
such a chunk also keeps the stretch of the message it holds (`text_start`,
`text_end`), so every reader below cuts the text the same way. The text is never stored. Chunks cascade with their conversation, so old builds' chunks go
with them. `chunk_vectors` is keyed by model and that hash, with no chat: a rebuild writes new
conversation rows, and a vector tied to them would be thrown away each time, while a chunk whose text
did not change keeps its hash and finds its vector again. `conversations embed` reads a chunk's messages
again (`chunksToEmbed`, `src/store/sqlite/vectors.ts`), rebuilds its text with `chunkTextOf` and embeds it
only when the hash still matches; a chunk whose messages changed since the build waits for the next one. A
search re-reads each meaning hit the same way (`chunkFreshness`) and marks it stale or drops it, and
`tombstone` deletes the vectors of the chunks a deleted message was in (`purgeVectorsOf`); how fresh each chat
is, is one query (`readiness`) behind `conversations status` and search's `readiness`. The same readiness picks
what `conversations links rebuild` and `embed` without `--chat`, `search conversations --catch-up` and MCP `conversations_refresh` do:
one service method, `embeddings.refresh`, bounded by chats and chunks. How
the search over them works, end to end and measured: [search-indexes.md](../storage/search-indexes.md#search-by-meaning).

**The owner's tags** are one table, `tags`, for a chat, a person (an `identities` row) or a
message — `taggable_type` and `taggable_pk`, so no foreign key. Triggers in the file drop a message's tags
when it is deleted or tombstoned and a chat's when it is deleted, so a build that knows nothing of tags —
0.49.0 included — cannot leave one behind; identities are never deleted. `tag:` in a strict search
compiles to one exact condition over the three (`src/store/sqlite/lucene.ts`), and `tags` commands and
MCP tools write through `services.tags` with their own permission keys (`tags.add`, `tags.remove`).

**A chat that takes a new id** (WhatsApp moving a person from phone number to LID) goes through
`store.chats.rekeyChat` (`src/store/sqlite/chat-rekey.ts`). A pushed `HistoryBatch.rekeys` reaches it
before the batch's messages through `rekeyChats`: the pairs in order, each in its own savepoint, in passes of
one transaction that each hold the write lock for about 50 ms, with a 25 ms pause between passes. The first
`serve` after an upgrade re-keys every phone-form chat; one transaction per re-key kept the lock so busy that
another command waited seconds for it. Once the store is about to close or refuses a whole pass, every re-key still
queued is given up with one warning and one `rekeys_not_applied` event that counts them; the next `serve` hands the
stored chats over again, and the messenger re-keys them then. Everything hangs off `chats.id`, so a chat stored only under the old id is
renamed in place. When both ids are stored, the old row is kept and the other merged into it: messages
move, a message id held in both keeps the old row's copy (deleted if either was), every `chat` and
`message` pointer (`pointerPairs`) moves, and the emptied chat is purged. The `sync_cursors` keys, task
locators and unresolved `msg:` evidence links that spell the chat id are rewritten in the same transaction.
Saved searches and note bodies stay as written. The old id is kept in `chat_revisions` (below), so a store-answered
read by it (`storedChatId`, `chatIdIn`, and so `messages list <old id> --offline`) finds the chat when no row holds
that id; a chat stored under the old id again wins. A re-key of a chat stored only under the new id records the old id
by hand, once.
A person with an open stay in both chats keeps one (`member_stays` allows one open stay per member), and the
merged chat is left only when both were. Privacy settings take the stricter half: hidden from search if
either was, and `personal` when the halves' effective scopes differ. After the store commits, `stored`'s `rekeyed` hook moves the entry
in the running profile's recipient list (`RecipientList.rekey`); a list that is off stays off.

**A chat's history** is `chat_revisions`, one row per field that changed: `external_id`, `title`,
`membership_state`, `scope`, `searchable` and `parent_chat_id`, the old and new value as text, the time and the
source (store version 25). A trigger on `chats` writes it, so the row is in the changing statement's transaction, is
written only when the value differs (`IS NOT`), and covers every writer: an older build still pinned by a consumer
and SQL by hand included. The trigger takes the source and time from `chat_revision_source`, one row that
`revisedBy` (`src/store/sqlite/chats.ts`) sets inside the store's write and deletes before the commit: `chats`
(`saveChats`), `delta` (`applyDelta`), `left`, `rejoin`, `rekey`, `merge`, `send` (a send's stricter privacy) and
`details` (`saveChatMetadata`). NULL means a writer that did not say — an older build or SQL by hand, which is how
a lost privacy setting shows. A row is account-scoped through `account_id`. No foreign keys, as `attachment_texts`:
an older build purges chats without knowing the table, and `chat_revisions_ad` drops a purged chat's rows; a merge
moves the absorbed chat's rows to the kept one first. Old titles are private data under the chat's own rules:
nothing indexes the table for search, mentions, involvements or embeddings, and no warning, event or run record
carries its values; `renamedChatId` reads only the old-id rows, to find a chat. Creating a chat is not a change and
records nothing, and nothing from before version 25 was recorded. A heavy account (about 2,000 chats) writes some
10,000–20,000 rows a year, most of them the first `serve`'s re-keys and title changes: a few MB (about 130 bytes a
row with its indexes), so nothing prunes it. The table grows without bound only when a value flips on every sync (a
chat list and `saveChatMetadata` that disagree on a title, a chat that drops in and out of the list): each flip is two
rows a pass. Nothing skips them, as a skipped revert would leave the history wrong;
`SELECT chat_id, field, count(*) FROM chat_revisions GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10` finds one. An older
build's merge does not know the table, so `chat_revisions_ad` drops the absorbed twin's rows; the kept chat's rows,
the re-key included, stay.

**The text of files** is `attachment_texts`, one row per attachment: what `attachments extract`
read from the file `messages download` saved (`attachments.local_path`, written by the download since this
version's package) — plain text, HTML, RTF, Word through `mammoth`, Word 97–2003 through `word-extractor`, a
PDF's text layer through `unpdf` (dependencies of this package, loaded on first use: `src/readers/pdf/`, picked by `src/readers/registry.ts`),
ODF/OOXML/EPUB through the built-in readers (`src/attachments/documents.ts`) — or what an agent wrote back after reading a scan
(`origin`: `extracted` or `agent`; an extraction never replaces an agent's text). Its words are in
`attachment_words`, contentless FTS5 with rowid = attachment pk, kept by triggers; a voice note's transcript
is its attachment's text with extractor `speech:<source>`. `content:` (file text) and `transcript:` compile to
exact conditions over it. A bare word (`Predicate.implicit`) also matches there and in file names: its leaf
ORs those sets in (`elsewhere`), the query is driven by the union of the sets and ranked by `message_words`
joined LEFT, with hits outside the message text tiered transcript → file name → file text (`lucene.ts`). No
foreign key, so the purges of older builds still work; triggers erase the text when its message is tombstoned
or deleted, or its attachment deleted (NEED-393 A, tested against 0.49.0). `store rebuild` rebuilds the index.
`attachments list is:needs_text` and `attachments update` (MCP `attachments_list`, `attachments_text_set`) are
how an agent finds a scan, reads it itself and writes the text back, all through `services.attachments`.

Remote agents receive retained bytes through bounded `attachments show` / `attachments_show`,
with whole-file SHA256 and account/message binding. See [attachment transfer](../attachments.md).

Agents perform self-OCR by default. Explicit `attachments extract --ocr` selects the
`models.ocr` gateway for bulk extraction; without it no model is called. Its typed
image parts are local validated base64, never a URL to fetch. Scanned PDFs use the
optional `unpdf`/`@napi-rs/canvas` renderer, at most20pages and bounded image bytes/
pixels; mixed PDFs keep text-layer pages local. The worker caps concurrency1–8,
keeps page order, and writes complete text atomically to the same table/index.
Extractor identity records OCR version/provider/model/endpoint hash; cache reuse
requires that identity plus the file hash. Failed or cancelled OCR never overwrites
good text. A provider rate limit stops later requests in the run, without retries.
Needs-agent items include localPath; it is a filesystem reference, not remote
artifact transport. OCR contract.

**Searches** are one table, `searches`: every successful `search messages` and `stats messages show`
run records its parameters as canonical JSON (`searchRecordOf`, `src/services/search-record.ts`) — never a
message or a result — from `MessagesService`, so the command and the MCP tool both record. An identical
unnamed run counts on its row (a unique index over command and parameters where the name is null); unnamed
rows past the newest 1,000 are dropped. A named row is a saved search, which `--saved` re-parses on every
run. `--no-record` (`ServiceDeps.history: false`) records nothing; a bot's search calls `searchStore` and is
not recorded.

**Where the queries live.** `src/store/store.ts` holds the `MessageStore` interface and `storeOver`. The
store is a set of areas, each a getter built on first use by its own file under `src/store/` —
`accounts`, `chats`, `sync`, `messages`, `attachments`, `roster`, `people`, `conversations`, `vectors`,
`counters`, `tags`, `mentions`, `searches`, `queries`, `searchIndex`, beside `mail`, `notes`, `files` (where each document is kept), `tasks`,
`meetings` and the rest: `store.chats.saveChats(key, …)`, `store.messages.find(…)`. An area that takes the
account first keeps that part apart where it also has store-wide methods (`AccountMessages`, `AccountPeople` …), and `forAccount` binds it whole, so
the bound store has the same areas without the account argument. The row-id helpers they share are
`src/store/keys.ts`, the shared types `src/store/types.ts`. An area opens the transaction and delegates. The SQL is in `src/store/sqlite/`, one module per kind
of record — `accounts`, `identities`, `chats`, `messages` (writes), `reads`, `search`, `ranges`,
`sync` (state and fetch leases), `transcripts`, `conversations`, `tags`, `searches` — as plain functions taking a `StoreContext`: the
connection as the `CacheDatabase` seam and as Drizzle (`orm`), and the clock. Queries are Drizzle's
builder, called synchronously (`.get()`, `.all()`, `.run()`); FTS `MATCH`, `json_extract` and the
`coalesce(excluded.…)` upserts stay `sql` fragments. A write goes through `write` and a multi-query read
through `read` (`src/store/sqlite/transaction.ts`), never Drizzle's `transaction` or a hand-written `BEGIN`:
the outermost `write` recomputes what the triggers queued (stems, mentions, involvements) before it commits,
and the nesting depth is kept per connection. A statement that runs for every saved message is `.prepare()`d once per store
(`identities.ts`, `messages.ts`): built per call, Drizzle cost about a quarter of the load rate
([results](../../bench/search/results.md#the-real-store-after-the-message-writes-moved-to-drizzle)).
`src/store/search-plan.test.ts` fails if search starts reading the text index once per message.

Opening a store also fills `messages.normalized_text` where it is missing, when at most
5,000 of them wait (`BACKFILL_ON_OPEN`, about 40 ms); a larger file keeps working and waits for the
maintenance command that fills it in batches.

**Two text indexes.** `messages_fts` (trigram over `text`) answers substring search. `message_words`
holds the words of `normalized_text` for ranked search — contentless with delete support,
kept by triggers that fire only when the normalized text, the sender or the chat really changed, with
a `scope` column of `c<chat_pk>` and `s<sender_identity_pk>` tokens. Ask its vocabulary through
`message_words_vocab` with `col = 'normalized_text'`, and restrict a word query to that column, or the
scope tokens come back as words. A file of at most `BACKFILL_ON_OPEN` messages is indexed by the
migration; a larger one records in `search_index_state` the highest `pk` the batches must reach.
`fillSearchIndex` (`src/store/sqlite/search-index.ts`) gets it there in batches of 5,000 — the
normalized text first, then the words, then the typo vocabulary (`search_terms`,
`search_term_trigrams`), then the words of messages stored since — from `store migrate`,
`store rebuild`, and up to 200 ms before each
`search messages`. When everything is built it returns without taking the write lock. `search messages`
ranks by it. `src/store/sqlite/words.ts` keeps `knownTerms` and `termCandidates`, which `--discover`
uses for typo correction; `src/store/search-plan.test.ts` fails if a search reads an index once per message.

**Stems.** `message_stems` holds the Snowball stems of `messages.text` — stemmed before
folding, by `createStemmer` (`src/search/stem.ts`) — in the same shape as `message_words`: contentless
with delete, the same tokenizer, the same `scope` tokens. A `text` term or phrase matches the word index
OR the stems (`src/store/sqlite/lucene.ts`), so no exact hit is lost to a different fold; `exact:` reads
the words only. A stemmed query is driven by a materialized set of the messages its indexes name, read by
key, and ranked by a materialized stems bm25 joined LEFT, exact forms first — joining the stems as the
ranked table would drop exact-only hits, and joining it row by row was 80× slower (`bench/stemming`).
While the stems are building, or chosen by a newer tool, search and stats run a stemmed query on the word index alone and say so in `query.stemming` (`applied: false`); only stems waiting for the owner's `store rebuild` refuse with `index.not-ready` (`searchStemming`, `src/services/messages-search.ts`). `serve` fills building stems a slice at a time (`stemFills`). A default the store saved carries `origin: "default"` and the defaults' version, so a newer default replaces it and an older build leaves it. SQL cannot stem, so the triggers only queue the message in `message_stems_pending`, and JS
writes the stems (`src/store/sqlite/stems.ts`): every store write empties up to 500 queued messages
before its `COMMIT`, and `fillStems` stems the messages up to the watermark and then the queue — on
open for a small file, in `store migrate`, `store rebuild`, and inside the same 200 ms before a search.
The `analyzer` column of the row records the Snowball version and stemmer choices that built it; the
first fill claims an unbuilt row. The choices are store-wide (`store_settings`, written by
`config set search_stemmers.cyrillic|latin`), since every profile, tg and MAX share one index. Ready
means filled to the watermark, an empty queue, and the analyzer this binary would build — an older
binary runs the triggers and never drains, so a flag alone would lie. Stems built by other choices are
written by nobody and rebuilt only by `store migrate` or `store rebuild`, never by a search, so two
tools with different settings or Snowball versions cannot rebuild each other's index in turn; a row a
newer Snowball built is refused with "upgrade this tool". The first claim and every rebuild also save the
choices, so a tool with another default sees a setting and refuses as "unknown" instead of rebuilding.
`latin` may name several stemmers: each Latin stemmer gives a stem sequence, and the distinct ones are
stored apart by `STEM_SEPARATOR` so a phrase never spans two; a query is the OR of its phrases.

**Notes and links (plan).** `MessageStore.notes`
(`src/store/sqlite/notes.ts`) holds the owner's records, which belong to no account: `note_folders` (an
id; the path is each computer's config), `notes` (from a file or written here) with `note_revisions`,
`entities`, and `links` — every connection, both ends a typed reference (`src/domain/references.ts`). A
link whose written target names no one yet keeps `target_folded`; creating, renaming or aliasing a person
resolves it in the same write (`resolvePersonLinks`, called from `identities.ts`, `private-people.ts`,
`person-links.ts`). `KnowledgeStore` and `contacts notes` read and write these tables. Builds before 25
may still write the old ones, so `openStore` copies what is missing on every open
(`src/store/sqlite/notes-copy.ts`, behind `notesToCopy`).

**Notes' search indexes.** The same words and stems as messages — `note_words`,
`note_stems`, same tokenizer and the store's stemmer choices — and their rows in `chunks`, whose hashes find their
vectors in `chunk_vectors` beside the conversations'. Triggers on `notes` only queue the note in
`note_index_pending`; `drainNoteIndex` (`src/store/sqlite/note-index.ts`) writes words, stems and chunks
in JS before every notes search, `chunksToEmbed` and `nearest`, and in `store migrate` and `store rebuild`.
Notes are few, so a change of stemmer choices queues them all again at the next drain instead of waiting
for a reindex. `searchNotes` (`src/store/sqlite/note-search.ts`) compiles the same parsed query as
messages over the fields a note has (`text`, `exact`, `body`, `tag`, `date`, `in`) and refuses the rest;
`searchNotesQuery` (`src/services/notes-search.ts`) is the service a `search notes` command calls.

**One `search` group (plan, STANDARD.md "Search hierarchy").**
`src/cli/messenger/search-command.ts` mounts `search all|messages|mail|notes|conversations` (and
`topics` where the messenger has forum topics); `bot search messages` sits under `bot`. Each leaf calls
the service the old command called, and the MCP tools are the leaves themselves. `searchAll` (`src/services/search-all.ts`) runs messages (every
messenger account, never mail), mail and notes in turn and merges their lists by reciprocal rank, so
no resource's own scores are compared with another's. A resource that cannot answer the query — a
field it lacks, or nothing stored — is listed in `skipped` with the reason instead of failing the search.
Its messages take the same server step as `search messages` (`--backend`, default `both`, through
`messages.searchAll`); mail and notes are always the local store's.

`searchAllIncludingMeetings` (`src/services/search-all-meetings.ts`) is a separate opt-in service.
It delegates the legacy search unchanged, then blends its ordered result with one explicit meeting
account's prefix matches. Meeting hits carry their numeric source identities and `ref`, the
`meeting:<accountId>/<meetingId>` reference of `formatMeetingReference` that memo takes as evidence. It resolves the account through `storedAccount` and never registers one.
Because `MeetingStore.search` pages meetings before matching their rows, the service visits
candidate meetings serially and keeps a source cursor inside a meeting's hit list. Sparse pages
can report unknown `hasMore` at the scan limit. The candidate bound does not bound the store's raw
hit allocation, and offsets do not give a snapshot. `search all --source` and the `search_all`
tool's `source` reach it through `messages.searchAllWithMeetings`, which never lets the meeting account
default to the messenger's own: it reads meetings only from the one meeting account the list names (of
several a bare `zoom` names, the one that holds meetings), and otherwise answers `skipped` for meetings. No meeting reference resolver or vector index is introduced.

**Server search beside the archive.** `messages.search` with `backend: both|server` first runs
`searchServer` (`src/services/server-search.ts`): it turns the resolved query into at most three
server queries (required words, one chat, one sender, dates), calls the optional `MessageSearch`
capability under a time bound, looks up which hits the store already held, and saves the rest with
`via: "search"` — never `markRange`, so ranges and coverage stay what `messages sync` proved. The strict
local query then runs once over everything; `server` restricts it to the returned messages
(`QueryExecution.only`). A page that arrives after the bound is dropped unsaved. The step is not wrapped
by `stored`, because it must look before it saves.

**Drizzle is bundled, not installed.** `drizzle-orm` is a development dependency. `pnpm build` runs
`scripts/bundle-drizzle.ts`, which writes the Drizzle modules the store uses into
`dist/store/sqlite/drizzle/`: loaded from `node_modules`, Drizzle costs Node about 200 ms per
process, bundled about 6 ms. So:

- Import Drizzle only through `src/store/sqlite/drizzle/` — `core.ts` for the query builder and
  schema functions (add a name there when you need one), `node.ts` and `bun.ts` for the drivers.
  Anywhere else, `biome.json` refuses `drizzle-orm` (`noRestrictedImports`, `biome.json:40`); the
  folder itself and tests are exempt (`:84`). A direct import passes the tests and crashes tg and max
  at runtime, where `drizzle-orm` is not installed.
- The Node and Bun drivers are separate bundle entries and are loaded by dynamic `import()`: each
  imports its own runtime's SQLite at the top of its file, so loading one under the other runtime
  fails.
- `scripts/check-dist.ts` refuses a `dist` that still imports `drizzle-orm` and reads a row through
  the bundle. Full validation runs it under Node (`pnpm check:dist`) and under Bun (`bun scripts/check-dist.ts`).

**Snowball is vendored, not installed.** `src/search/snowball/` holds the official Snowball 3.1.1
JavaScript for Russian, Spanish and English, generated by `bin/snowball-update` (BSD-3-Clause, also in
`THIRD_PARTY_NOTICES`). Never edit it by hand; `bin/snowball-update --check` proves it matches the
source. `tsc` does not emit JavaScript it did not compile, so `pnpm build` copies it with
`scripts/copy-snowball.ts`, and `scripts/check-dist.ts` stems a word from `dist`. Use it only through
`createStemmer` (`src/search/stem.ts`): it picks the stemmer by the script of a word, stems, then folds
with `normalize()`, and its `identity` names what built an index.

### Entities and source records

The rules are in the cli-base handbook, [Data model](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/data-model.md)
(WC-DATA) and [Architecture](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/architecture.md#wc-arch-21--a-cli-registers-its-provider-in-the-store-an-unknown-providers-rows-are-skipped-never-guessed)
(WC-ARCH-21). This part says how the store follows them. The approved design is cli-private
`plans/2026-10-24-open-cli-core-design.md` (Wave 3); what it adds is marked **not built yet**.

**Two kinds of table.** An *entity* is the thing the owner means: `persons`, `events`, `event_series`, `documents`.
A *source record* is one source's copy of it, keyed by `account_id` (or `provider`) and `external_id`: `identities`,
`meetings`, `emails`, `messages`. A source record points at its entity (`meetings.event_id`); one entity may gather
copies from several sources. `documents` still carries its source's columns (`account_id`, `external_id`, `url`,
`front_matter`…, `schema.ts:945`); they stay for compatibility once `files` exists.

**Core entities and a CLI's own tables.** A table more than one tool needs lives here, with its migration and its
store area. A CLI's own bookkeeping never enters `wirecat.db`. **Not built yet:** a helper that opens a CLI's own
SQLite file next to the shared store, with the CLI's own migrations (NEED-1737); it waits for the first CLI that
needs one.

**The provider registry.** cli-core no longer needs a release per provider. A CLI calls `registerProvider`
(`src/store/providers.ts`, exported from `./store`) on every run; it writes `{ name, kind, aliases, command }` into
`store_settings` under the key `providers` (`src/store/sqlite/providers.ts`). Every store handle loads the stored
entries when it opens (`src/store/sqlite/open-store.ts:78`) on top of the built-ins (`PROVIDERS`,
`src/domain/providers.ts:17`), so `kindOf` and `providerNamed` keep their signatures. Two entries with different
kinds fail with both names. Searches skip the accounts of a provider nobody registered and list them under `skipped`
(`UNKNOWN_PROVIDER`, `src/search/account-list.ts:258`).

**Documents and files — not built yet.** A new `files` table holds one row per item in one place: a local file, a
Drive file or folder, later a Notion page. A folder is a `files` row; children point at it with `parent_id`, and
`path` / `path_folded` find a subtree by prefix (NEED-1739). A file joins a document by `account_id` + `external_id`,
then by `content_hash` when exactly one live document matches; more than one goes to the review list. Folder
accounts become `local` or `obsidian` (NEED-1738).

**Drive documents live in a `google-drive` account**, one per Google account (`external_id` = the principal), since
store version 31 moved them there from the stand-in notes folder named `google-drive:<principal>`. The account's
`settings` keep `format` and `movedFrom` (the folder's id, external id and name). The notes code reads and writes
such an account as it does a folder (`DOCUMENT_ACCOUNT_PROVIDERS`, `src/domain/providers.ts`), but
`notes.folders()` leaves it out: `notes.documentsAccount(key)` and `documentsAccounts()` find it, and
`documentIngestion({ provider })` writes into it. Search still lists it as `notes:<id>`, until Drive becomes kind
`documents` (Wave 3 R2). Annotation transfers name it `google-drive:<principal>` on both sides of version 31.

**Calendar entries on the events hub — not built yet.** `calendars` and `calendar_entries` are a calendar's source
records; `events` (`schema.ts:1087`) and `event_series` stay the entities that `meetings` already points at. An
entry matches by its Google id, then by series slot, then by `ical_uid` across calendars, then by Zoom's join key
with an overlapping time. Attendees are `calendar_entry_participants`; changed fields go to
`calendar_entry_revisions`; a past occurrence deleted in Google keeps its event with `source_deleted_at`.

**Contacts.** A contact is an `identities` row (`schema.ts:134`): one person as one source knows them, linked to a
`persons` row through `identity_links`, every change logged in `identity_link_events` (`schema.ts:152-191`).
**Not built yet:** an `identities.email` column, so contacts with one address join one person.

**Links and the review list.** A link records its method, confidence, author and time; an owner's link is never
replaced by a rule. Today only contacts have that shape. **Not built yet:** `entity_link_events`, the same log for
events and documents, and one review list of ambiguous pairs, shaped like `task_pairs` (`schema.ts:1468`).

### Migrations

Store version 1 created the tables of [`docs/storage/schema.md`](../storage/schema.md) in the file `wirecat.db`, and
each later version adds to them. Version 1 is one folder under `drizzle/`: the SQL `pnpm db:generate` wrote from
`src/store/sqlite/schema.ts`, then the FTS5 indexes, their triggers, the `WITHOUT ROWID` search-term tables and
the seed rows, which Drizzle cannot model. `pnpm db:bundle` copies every folder into
`src/store/sqlite/migrations.generated.ts`, and `src/store/sqlite/manifest.ts` numbers them. Our runner (`migrate`)
applies migrations under `BEGIN IMMEDIATE`; Drizzle's own migrator is not used.

The schema before this one lived in `messages.db` and is not converted: the new file has a new name so that a
build still installed never opens it. Every migration after the first is forward-only, additive, numbered, and
never edited once it reached anyone's file — a test refuses a generated rebuild of a base table.
`min_compatible` lets an older CLI keep using a file a newer one migrated; a migration that drops what an older
build reads raises it, and that build then refuses the file and asks to be upgraded. Store version 30
sets it to 30 for the tag/automatic-claim structural compatibility boundary.

⚠ **Announce a migration number before writing it.** Several sessions work in this repository at
once, and two of them taking the same number is a conflict no rebase fixes. The next free number
lives in [COORDINATION.md](COORDINATION.md#store-migrations); take
it by editing that line in a PR of its own, merged before the migration.

#### Adding a migration

1. **Take the number** as the paragraph above says, and wait for that PR to merge.
2. **Change the spec first**, `scripts/schema/spec.mjs`, and `pnpm schema:render` for the page. Then change
   `src/store/sqlite/schema.ts` to match, until `pnpm schema:check` passes (the pull request's full validation runs it too), and run
   `pnpm db:generate --name version-<n>-<what>`. It writes `drizzle/<timestamp>_version-<n>-<what>/migration.sql`.
3. **Read the SQL before anything else.** For a constraint change (a new `NOT NULL`, a changed
   default, a foreign key), drizzle-kit rebuilds the table: `CREATE TABLE __new_…`, copy, `DROP TABLE`,
   `RENAME`. A build already installed breaks on that, and on `messages` the `DROP` also removes the
   full-text triggers. Choose a change drizzle-kit can express as `ALTER TABLE … ADD` — a new column is
   nullable or has a default — or a new table. The test "never rebuild a base table"
   (`src/store/sqlite/manifest.test.ts:14-19`, `:46`) refuses the rest.
4. **Triggers, FTS5 tables and data fills go in a custom migration**, since `schema.ts` holds neither
   triggers nor FTS: `pnpm db:generate --custom --name version-<n>-<what>`, then write the SQL into
   the empty file. Put `--> statement-breakpoint` between statements — the bundle splits on nothing
   else (`scripts/bundle-migrations.ts:20`), so a trigger body with `;` inside stays whole. Generate
   it right after step 2: folders apply in name order, which is their timestamp.
5. **Add a row to `MANIFEST`** (`src/store/sqlite/manifest.ts`) for each new folder, with the same
   `version`. Two folders with one version — the generated one and its custom one, as version 7 —
   apply as one migration and write one `schema_migrations` row. Versions run on without a gap
   (`manifest.test.ts:38-44`).
6. **`minCompatible` stays where it is** — 30 after the tag compatibility boundary — for an additive change. Every manifest row declares it explicitly; it cannot decrease. Raising it locks every
   older build out of the file: ask the owner first; it is a major version of this package, and
   tg-cli and max-cli ship their upgrade the same day.
7. **`pnpm db:bundle`** after every `db:generate` and every edit of a `migration.sql`. It rewrites
   `src/store/sqlite/migrations.generated.ts`; `pnpm build` does not, and the test "are bundled
   exactly as drizzle-kit wrote them" (`manifest.test.ts:22`) fails until you run it.
8. **Test the upgrade**: a `src/store/version-<n>.test.ts` opens a file at version n−1, migrates it and
   reads what the new version added. `src/store/upgrade.test.ts` already opens a store 0.218.0 made, at
   version 1, with every migration and keeps its rows. `src/store/sqlite/schema.test.ts` opens a new store and compares
   every table and column with [`schema.md`](../storage/schema.md), and compiles every trigger:
   change the page with the schema.
9. **CHANGELOG**: an entry under `## Unreleased` that names the store version, as "Poll votes in the
   store (store version 20)" does.

A migration is frozen once released: fix a mistake with the next version, never by editing a folder.
`upgrade.test.ts` pins version 1 by hash, and `bin/regen-initial-migration` refuses once a `v*` tag holds it.

### Open tasks

Tasks waiting on the owner belong to `src/tasks/` (exported as `./tasks`), which knows no messenger and
no SQLite; `biome.json` holds it to that and lets the rest of the package import only its entry points.
The store implements its `TaskStore` as `store.tasks`, in the `tasks` table
(`src/store/sqlite/tasks.ts`), so backup, restore and export carry tasks with the messages, and a task
joins its message in one query. A task holds a locator, never the message text; `kind`, `state` and
`origin` are checked in code, as `chats.kind` is.

A bug, feature or chore has no message behind it, so it never reaches the package: `store.tasks.create`
(`src/store/sqlite/work-tasks.ts`) writes it into a project the owner names, keyed `<project key>-<n>`, with no
package id, and the package's reads skip rows without one. `edit`, `assign`, `details`, `find` and `events` work
on any task — priority, parent, description, assignees and the verdict the package does not carry — and each
change of status, due date, priority or assignee is a `task_events` row.

## The command skeleton

Public command factories protect their contracts through the shared base registry. Provider
edits use [explicit contract overrides](SHARED-CONTRACTS.md); schema and reason evidence is
available through `commands info --json`.

`run()` (`src/cli/program.ts`) never throws; it returns an exit code. It lifts a profile given as
the first word, resolves settings (flag → environment → file → default, `src/cli/settings.ts`),
records runs (`src/runs/`; the `runs` command is `src/cli/runs/`) and closes what a command holds when `--timeout` ends it
(`src/cli/deadline.ts`).

Optional `ProgramDefinition.configure`, `prepare` and `onFailure` let a consumer add root options,
provide legacy command context and settle its own recording before the shared fallback.
Help/version exits skip failure settlement. The lifecycle contract
describes the order and failure behavior.

A CLI describes its messenger once — a `Messenger` (`src/cli/messenger/context.ts`) with a
`connect` that returns a `MessengerAdapter` (`src/ports/messenger.ts`) — and gets the shared
commands, one file per resource in `src/cli/messenger/`. Two wrappers sit between a command and the
adapter: `observed.ts` times each call into the run record, `stored.ts` saves what was read. A new
adapter method is optional and reached with `capability()`; the wrappers pass through any method
they do not name. How to write an adapter for a new messenger, and test it with the contract cases,
is [the adapter guide](ADAPTERS.md).

The MCP server (`src/mcp/server.ts`) holds one connection for minutes and runs one call at a time. Its tools are
the CLI's commands (`toolsFromCommands`, `src/mcp/agent.ts`), each run in-process through the CLI's own `run`
(`runCommandForAgent`) on that connection, so a tool answers and refuses exactly as the command does. What only an
agent needs comes from the command's metadata: `mcp: false` and `ownerOnlyOption` keep a command or an option off
MCP, `grantsAuthority` offers a command only where the profile allows `mcp.authority`, `bot api` only where it allows `bot.api`, `readsStdin` turns what a command reads on stdin into an input field. The tools that answer with an image
(`messages photo`, `attachments show`, `stats charts`) stay definitions of their own (`src/mcp/tools.ts`).

`mcp --http` (`src/mcp/http/`, CLI-58) serves the same factory over Streamable HTTP on 127.0.0.1 behind the
owner's tunnel. `oauth.ts` is a one-owner OAuth server — a token needs the code printed in the terminal, and
only token hashes reach the disk; `serve.ts` checks the Host, answers the login routes, requires a bearer
token for `/mcp`, and sends 2025-era requests to per-session servers bound to their OAuth client, because a
stateless server forgets the form capability a client declared in `initialize`. Writes over HTTP follow the
profile's permissions exactly as over stdio; no form is forced (NEED-774, which replaced NEED-593).

## The serve relay

A messenger that allows one connection per account — WhatsApp drops the first when a second opens — sets
`Messenger.connection: "exclusive"`. Its `serve` then runs the other commands for the profile on the connection
it holds (NEED-1389):

- **Discovery.** Once listening, serve opens a Unix socket beside its lock (`relayPath`, mode 0600 in the 0700
  `serve/` directory; a path too long for a socket moves to a private directory under the system's temporary one)
  and writes `relay: { path, protocol }` into the lock. `run()`'s `preAction` (`relayTarget`, `src/cli/relay-route.ts`)
  sends a command there when the lock's process is alive and offers a relay, and the command reaches the messenger
  (`effects.remote` not `none`) — except `serve`, `server`, `bot`, logins (`lifetime: "interactive"`), a command
  whose remote side is another service (`reachesOtherService`: `conversations links rebuild` and `embed`, `search
  conversations`, the model downloads), `--offline`, `--dry-run` and `mcp --http`.
- **The command, not the adapter.** The client sends its argv, environment, working directory and stdin
  (`src/background/relay.ts`, one JSON object per line); serve runs `run()` again in-process (`runCommand`) and
  streams back each `data`, `diagnostic` and raw stdout write, then the exit code. Parsing, settings, the send guard,
  the journal and rendering are the direct run's own code — the guard runs in serve with the client's environment,
  so `<PREFIX>_READ_ONLY` holds and the socket is no way around it.
- **The borrowed connection** (`serveRelay`, `src/cli/messenger/serve-relay.ts`): serve keeps the raw adapter its
  `connect` returned; `connectFor` hands a relayed run that adapter with `close` doing nothing, no `feed` or
  `storedChats`, no `listen` or `listenHistory`, and a `watch` that subscribes to serve's own events. A relayed run for another
  profile is refused. A CLI's own command that connects goes through `connectFor` too, or inside serve it would
  open a second connection.
- **Per run, not per process.** A relayed run adds no signal handlers, never prompts (`answer` is null — `ask`
  needs `--yes`), resolves path-named options and arguments (`<file>`, `<path>`, `<dir>`…) against the client's
  directory (`absolutePaths`), keeps its exit code in `environment.exit`, and `mcp` runs its stdio session over
  the relayed streams.
- **Failures.** No live lock: the command connects on its own. A lock that offers a relay whose socket does not
  answer: `provider_unavailable`, never a second connection. serve gone before the exit: `outcome_unknown` for a
  write. Another relay protocol: refused with "restart serve"; another CLI version is relayed with one line naming
  both. A relayed watcher that throws ends its own watch, never serve's.

## Services

Five layers, each calling only the ones below it: the **domain** (`src/domain/`), the **adapters**
(each CLI's own, behind `MessengerAdapter`), the **ports** (`port.ts`, the store), the **services**
(`src/services/`) and the **interface** (the commands and the MCP tools). `biome.json` refuses an import of `commander` or
of anything under `src/cli/` from `src/services/`, `src/sends/`, `src/replies/`, `src/attachments/`,
`src/moderation/`, `src/models/`, `src/analysis/`, `src/domain/` and `src/ports/`, and of a command file from
`src/mcp/`: what they share with a command lives below it, and the command imports it. A service sees the
messenger as `MessengerTraits` (`src/ports/traits.ts`), the fields it reads; the CLI's `Messenger` adds how
commands connect and resolve settings. The app's identity is `src/ports/app.ts`, error shapes and reasons
`src/errors/`, run records and log keys `src/runs/`. It also refuses a table module under
`src/store/sqlite/` from `src/services/`, `src/sends/`, `src/mcp/` and `src/cli/`: they reach the store
through `src/store/store.ts`, which re-exports what they need.

A service is a plain object made by a factory over `ServiceDeps` (`src/services/deps.ts`): the
messenger, `offline`, and a connection, a store and an account that are each opened on first use —
so a read from the store never connects. A service reads and writes through `accountStore(deps)`: the store
with the running account bound (`store.forAccount(key)`, then `.messages.messages(chatId, …)`), where no call takes an account and a row id of
another account — an attachment, a mail thread, a meeting — is not found. A read across accounts on
purpose takes the whole store from `crossAccount(deps, reason)`. `chats`, `conversations` and
`attachments` work this way; the other services still pair `deps.store()` with `deps.account()`. `servicesFor(deps)` hands out `messages`, `chats`, `people`,
`inbox` and `archive`. A command gets them from `withServices` on its context, which closes what was
opened; an MCP tool builds them over the session's connection with `onlineDeps`, or over the store
with `storedDeps`. The services callback can also borrow the held
connection for hearing. It fetches recordings on that connection and releases it before local
recognition; closing is awaited once, and store cleanup still runs if closing rejects. Review's
optional `enrich` hook runs after admin lookups and before unanswered filtering, so transcript text
can supply a voice question without changing the archived message text. MCP retains session-owned
connections. Either way a command and its tool run the same method, and so answer the same
error for the same input. Each caller still parses its own input, so an error names `--since` in a
command and `since` in a tool.

**A messenger that pushes its history reads it from the store.** `Messenger.history: "store"` sets
`ServiceDeps.reads`, and every read that `--offline` answers from the store — `chats list|show`,
`messages list|context`, `contacts list|show` — answers from it for that messenger without
`--offline`, and never connects; writes still do. `serve` keeps the store filled, so such a read
warns on stderr when no `serve` holds the profile, and a chat with nothing stored is `not_found`.
`inbox` and `review` read the stored chats and messages through `storeReader`, the same code over
an `InboxReader`, so their `--json` is the online one; `messages sync` refuses for now, and `--sync-first`, MCP
`sync_first` and the `messages sync` next steps of search and contacts are not offered. The MCP chat
resource reads the store too, and so does an MCP tool with a `served` body: it gets the services
over the store and reaches the session's connection only through `connect`, for transcription.
Names come from the store too. A write still connects, but the chat it names (`resolve`), the people a group
change names (`people`) and the chat titles `watch` leaves out are looked up among the stored chats and people
first (`Saving.namesFromStore` in `stored.ts`), with the same matching and the same refusal of an ambiguous name as
the store reads; only a name the store does not hold reaches the adapter.
Such a messenger may deliver what it queued while nothing was connected to any connection, once. When its adapter
has `listen` or `listenHistory` (`PassiveUpdates`), `connected` runs each it has for as long as a connection opened
without `listen: true` is open: `listen`'s events are saved as `watch`'s are, `listenHistory`'s batches by `feed`'s
own code (`saveBatches` in `stored.ts`), re-keys first. `close` closes the connection, then stops both and waits
for them to end, 5 s at most in all, then for the saves, then closes the store. A connection opened with
`listen: true` is left to its `watch` and `feed`, so nothing is saved twice. A failed listen warns
(`listen_failed`) and never fails the command; it is neither held nor paced, as it only receives. Its run record is a
`messages.listen` or `history.listen` request and response, the operation its warnings name too; the response counts
what `listen` handed on by event, as `messages.watch`'s does, and what `listenHistory` handed on as `batches` and each
part's items.

**A CLI replaces a use case, not a command.** `Messenger.services` is an `Override`: it gets the
shared services and returns the ones it changes, and can call the shared method inside its own:

```ts
services: (base) => ({
  messages: { ...base.messages, list: (chat, window) => maxList(base.messages, chat, window) },
}),
```

Commands and MCP tools both see the replacement. To add a subcommand, a CLI calls `addCommand` on
the command a factory returns.

Saving what a read answered and timing each call stay decorators on the adapter (`stored.ts`,
`observed.ts`), stacked by `connected()` in `context.ts`, so no service can forget to save.

## Who consumes it

- **tg-cli** — the whole skeleton, the store, the guard and the MCP server; its adapter is under
  its own `src/telegram/`. To try an unreleased change: `bin/try-messaging` in a tg-cli checkout
  beside this one, never a committed `file:` path.
- **max-cli** — both its personal account and its bots. The personal account is a
  `Messenger` (`src/messenger.ts`) whose `connect` returns `maxAdapter` (`src/adapter/max-adapter.ts`)
  over max's own protocol client, and it uses the shared commands, services, store and guard; its
  own cache is gone. max keeps its protocol, session,
  `max serve`, the Bot API slice and its own MCP server (`MaxSession`, `src/mcp/server.ts`), whose
  tools run the shared services through `withShared` (`src/mcp/shared.ts`).

Both pin an exact version; a change here reaches them through a release and a bump in each.


## Package upgrades

`upgradePackage` (`src/services/package-upgrade.ts`) owns the explicit upgrade decision and invokes
installer/latest/install and optional host lifecycle ports. `upgradeCommand` renders its outcome;
consumers bind their existing update environment and server restart policy. No installer runs on
check/no-op paths, and a failed install or callback never retries. The upgrade plan
describes the common result and consumer adoption.


## Agent conversation linking over MCP

`conversations_batches_status` reports messages, batches, characters and a token estimate before
text is fetched; `conversations_batches_next` returns the next window or `{ batch: null }`.
`conversations_links_add` stores batch answers atomically, `conversations_links_clear` drops them,
and `conversations_build` rebuilds one stored chat without inference. The last three write only
locally under `conversations.links`: readonly/deny hides them, ask refuses with the config key.
The `link-conversations` prompt reads the same shipped skill as the CLI; its cost/consent gate is
per chat. These tools call `services.conversations`; inference in this MCP loop belongs to the
owner's agent. The explicit CLI `build --analyze` path can call a
configured provider with consent; see [AI providers](../search/ai-providers.md).

Consumer parity: planned for both CLIs on their next SDK adoption. Source-level shared schema and
synthetic MCP proof are tested here; installed consumer parity is not claimed before publication.

## Bounded preparation after history fetch

Per-profile `search_catch_up` defaults to false; messages sync can override it with --catch-up or
--no-catch-up. The fetched chat alone is prepared with500chunks,10,000messages and30seconds by
default. Explicit budgets have hard caps. Invalid permissions/bounds refuse before connection;
missing local e5 keeps graph-only progress, without downloading a model or using a remote provider.
Fetched history persists even when preparation stops; the result reports a separate prepared state.

Cancellation checks run through input reads, linking, chunk cutting and staged publication. A
failed staged build leaves the previous published generation available. Completed builds remain
valid if later vector preparation stops. Edits and successful rebuilds prune affected vector hashes,
verifying current text across shared users. Shared-use checks are bounded; an inconclusive hash is
kept rather than removing another account's valid cache. Deletion safeguards remain in force.

## Interior archive gap repair

`store gaps show <chat>` uses recorded inclusive coverage ranges, with versioned account/chat/order
identity and a fingerprint. Unknown archive edges remain separate from interior gaps; message-id
holes and quiet periods alone do not establish missing history. Planning is local.

`store gaps repair <chat>` explicitly fetches up to five gaps and500messages within30seconds by
default. `--max-gaps`, `--limit`, `--repair-time`, `--page-size` and `--pause` set bounds. Optional
`--fingerprint` refuses a stale plan before connecting. A per-account/chat lease prevents concurrent
repairs, while every page persists through the existing ingestion path. Repeated timestamp pages,
partial responses and inaccessible history stay pending; nothing is deleted by absence. Re-running
plans the remaining ranges. `--background` uses `store jobs show/list/cancel` and captures the plan's
fingerprint. MCP offers matching plan/repair and profile-scoped job metadata tools.

Repair requires `store.gaps.repair` write permission and message read access. The optional
`Fetching.beforeInclusive` adapter declaration describes native timestamp cursors; it does not
change regular fetch behavior.

Repair accepts the same catch-up overrides and budgets as fetch. One preparation follows the repair,
within its remaining overall time budget; history completeness and preparation progress stay separate.


### Adapter settings compatibility

`settingsFor(app, extension)` owns common settings resolution. An optional `resolve` hook receives
resolved common settings, ordered personal/bot/profile/default layers and `fromLayers`; it returns
adapter values and their sources without rereading configuration. `profile` and `defaults` extend
the generated strict schema. An optional `schema` validates both reads and writes when an existing
consumer needs stricter scope rules or unchanged errors; it must produce the common configuration
shape, including `profiles`. `sourcePaths` opts into full configuration paths, including legacy
permission provenance. `parseDuration` preserves a consumer's duration syntax and diagnostics.
Without these hooks, existing source labels, validation and duration parsing stay unchanged.

## Administrator statistics

The shared `adminStatistics` service implements unanswered, selected-identity response times,
known-join newcomer help and stored discussion reports. `admin-statistics.ts` in the SQLite seam
uses compiled query selection and bounded context within one read snapshot. Question selection is
separate from reply context through a captured cutoff. Membership stays distinguish joinedAt and
firstSeenAt. Reports and their saved runs reuse existing CLI/MCP discovery and evidence paths; a
separate versioned selection binds query, options and cutoff. See the [user guide](../rankings.md).

## Retention and counter observations

Migration 24 adds `membership_batches`, `membership_batch_members` and
`message_counter_observations`. Only explicit remote reads/updates record observations.
Legacy rows are not backfilled with observation times. Batch membership points to identities and
separate stays; partial lists cannot close stays. Definite known rejoining dates split stays.
Invalid, duplicate and out-of-order roster observations are rejected atomically.

Retention uses SQL lookup of the first batch within a checkpoint's 24-hour tolerance, then bounded
cohort aggregation (10,000 stays, ten checkpoints, 8 MiB fingerprint, 64 KiB evidence).
One read transaction pins membership and activity. Cohort selections freeze cutoff and options;
existing message-evidence CLI/MCP paths page through member evidence.

Counter timestamps are independent by field and tied to the exact observed value. A legacy writer
can still use schema 6 statements; differing legacy values have unknown freshness. Counter-only
updates preserve other message fields and ignore tombstones. An older response cannot replace a
newer authoritative observation. Rankings/evidence expose these states and fingerprint observation changes.

The optional adapter `fetchCounters` returns explicit counter observations; `Messenger.counterFields`
declares static support for a connection-free preview. The shared service resolves a bounded query or
exact locator selection before connecting and guards `stats.messages.counters.refresh` as a local write.
It closes stalled connections on abort and records partial results without message actions.
CLI commands and the existing three-tool MCP frontend share this service. See [statistics guide](../rankings.md).

## Meeting integration capabilities

The meetings module (`src/meetings/`, once `@wirecat/cli-meetings` 0.4.0) supplies optional ports
alongside the unchanged base meeting store. Native event and participant association writes check the
selected account, live target and optional previous value in one transaction. Participant association
moves only one identity and records its manual audit and account observation; it never merges entire
people from display names.

`createMeetingContextService` reuses existing notes, knowledge and memory stores with canonical
meeting references. It validates account ownership and evidence on preview and again before apply.
Writes require explicit application; owner memories are confirmed as in memo. Memo already provides
meeting notes, tags and memory commands, so providers reuse these records instead of creating
another knowledge system.

`searchHits` pages inside one occurrence with an account/query-bound continuation and stored text
byte budgets. Each term matches a literal prefix or a configured shared Snowball stem variant;
English, Spanish, Russian and disabled stemming follow existing store settings. Tokens longer than
1024 characters match literally. `indexSearch` explicitly maintains a bounded account queue batch;
read pages do not drain queues. Write transactions keep the bounded shared involvement queue current.
Coverage reports pending indexing and unknown archive completeness. Append receipts
count new occurrences, inserted/replayed revisions and superseded revisions in the same transaction.
Their legacy full meeting snapshot still hydrates retained history; compact CLI receipts do not
change that store limitation.

`openLocalSpeechRecognizer` uses an already installed speech model, bounded mono PCM windows and
bounded text. It never downloads a model and loads the existing engine only when explicitly opened.
Cancellation occurs between synchronous inference windows. Model provenance identifies the pinned
registry configuration; importing the descriptor requires no installed files.

## Shared result projection

The CLI's `fieldsOf` and `projectFields` delegate to cli-base's shared parser and projector.
Payload-relative dotted paths traverse objects and arrays; `items.ref` selects each list row's
reference. Item/list envelopes, coverage, continuation, missing data and execution metadata and
operation identifiers stay intact. Parent selections retain an entire subtree. Parsed and direct
paths reject unsafe or empty selections, more than 128 paths, or paths longer than 256 characters.
The runtime peer and development pin require cli-base 0.31.1 for this shared behavior.
The messenger runner retains its own write and resource lifetime policy; no store schema is involved.

## File and folder catalog

`MessageStore.catalog` stores provider-neutral file/folder metadata and parent keys in the existing
`documents.metadata.catalog` namespace. Providers supply account-scoped external IDs and optional
observed actors; metadata-only entries have no text. Upsert preserves live text, content hashes,
revisions and other extracted metadata. Content readers preserve the catalog namespace when updating
metadata. Stable `document:<id>` references reuse tags, notes and relationships; Google folder
hierarchies remain distinct from notes collections. Reconciliation marks absent entries inactive
without deleting annotations. Reads use explicit account IDs with bounded pages and metadata;
provider adapters own hierarchy navigation. No migration or provider dependency is added.

## Meeting read batches

Base owns bounded input, registered-handler preparation and correlated serial execution. Core's
`src/cli/meeting-batch.ts` reuses the pure grammar from the independent meetings module and the
standard envelope/formatter. `src/services/meeting-batch.ts` binds the existing meeting search,
index and passage operations to one host-selected account. The batch performs one bounded index
pass; single searches retain their existing refresh policy. No provider or shell dispatch is introduced.
