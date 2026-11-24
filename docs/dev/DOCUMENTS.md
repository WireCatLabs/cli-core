# Shared document workflows

Provider authors can import a file tree, index its contents and attach local knowledge through
`@wirecat/cli-core/documents`. Core owns the workflows; a provider supplies authentication,
API translation, native-format conversion and account-bound I/O. No provider SDK is imported by
this module, and importing it opens no database, model or network connection.

## Boundaries

| Layer | Location | Responsibility |
| --- | --- | --- |
| Domain | `src/documents/` | Source file/content/change/state contracts, folder scope and catalog selection |
| Services | `src/services/documents/` | Discovery planning, resumable sync execution, ingestion, knowledge and evidence-backed extraction |
| Persistence | Existing public `store.notes`, `store.catalog`, `store.memories`, `store.facts` APIs | SQLite transactions and stored entity invariants |
| Readers/models | Existing document readers and model gateway | Text extraction, embedding/search and explicit model execution |
| Provider application | Outside Core | Credentials, vendor errors, API clients, configuration paths, snapshot/checkpoint persistence, locks and CLI/MCP presentation |

`src/documents.ts` is the public facade. Existing reader exports remain available. Consumers use
that facade rather than internal service or model files. Biome rejects upward imports from the
domain, SQL/transport/vendor imports in services, and private document imports from other modules.

## Bind a provider

1. Normalize remote metadata to `SourceFile` and extend it with provider-specific fields as needed.
   Implement `DocumentSource`: identity, folder metadata/children, change cursor, content and bytes.
   Map vendor folders with the supplied `isFolder` predicate; no Google MIME type is assumed.
   A node that is both, such as a wiki page with sub-pages, answers `isFolder` and the optional
   `isDocument`: the sync walks its children and imports it too, a root page included. A root must
   still be a folder, so a source whose pages can hold sub-pages calls every page one. Give such a
   page catalog kind `file`: its children name it as a parent, and the catalog places them under it.
   A saved `exclude` query that matches such a page, or a plain folder, drops the whole branch:
   the page and everything below it leave the documents and the catalog, and the sync does not
   list below it. A file that also sits under another parent the query keeps stays in scope. A
   selected folder the query matches drops only its own row.
2. Bind `documentIngestion` to the public store. Supply the provider, external-ID mapping, catalog
   metadata and content front matter. The optional `observed` callback registers provider
   identities/roles. Identity mapping remains the provider's responsibility. A provider is a
   documents provider when its registry entry (`openAppStore`'s `provider`) has kind `documents`
   and is not `imported`: each principal then gets a documents account, `{ provider, account }`.
   Its content front matter names it in `source` (`{ source: "notion" }`): that keeps a copy of
   the file in a notes folder from joining the document by content, and places the document by
   its catalog parents rather than by path. In a vault, front matter is the owner's own text: a note whose `source`
   names a documents provider is treated as a copy of a remote document, as an exported Drive file
   always was (not joined by content, its `sourceUrl` and `modifiedAt` shown). The provider list is
   read when the store opens, so a process that stays open, such as an MCP server, sees a provider
   registered after it started only once it opens the store again.
   The external id of a source file is `<id>.md` (``externalId: (id) => `${id}.md` ``), in the catalog
   entry, its parents and the saved note alike: the catalog commands strip `.md` to show the source's id.
   The store sets no ceiling on an account's entries; one catalog write takes at most 200 and one
   list page at most 1000, and a save or a removal reads only its own document. The sync has no
   total ceiling: `maxEntries` (drive passes 10 000) and `budget` bound one call, and the next
   sync goes on from there ([Walks over several syncs](#walks-over-several-syncs)).
3. Supply `SourceStatePort` for validated account-specific checkpoints, discovery walks and
   snapshots. Existing Drive v1 checkpoints remain compatible; no database migration is required.
4. Acquire the account/profile lock before `syncDocuments` and release it in `finally`. Supply
   `assertHeld`, provider-safe `errorOf`, classification/retry rules and positive bounds. The shared
   engine retains failed work, advances the cursor only after the batch completes and retires
   sources leaving the selected tree. The state account must match the selected principal.
   `documentIngestion` also gives the index `settle`: at the end of each sync the engine indexes
   the store's waiting text for word search, so a read-only reader finds a page by the words of its
   text right after the sync. The queue is the store's own, shared by every tool that writes to it,
   so this step may index other tools' documents and notes too. It works 50 rows at a time and
   yields between batches, stops after 10 s, at the run's `deadline` less its margin, or on the
   signal, and is skipped after a budget stop. A search that can write indexes the rest itself.
5. Bind `documentKnowledge` to a collection resolver for the selected principal. Every operation
   checks ownership; notes, facts and memories must also be attached to that document. Replacements
   cannot reach another document/account. Core's existing fact store owns decision transitions.
6. For AI extraction, inject a configured `complete` function. `extractMemories` validates bounded
   structured proposals and exact source quotes. `extractDocumentMemories` adds tab selection,
   preview/save, provenance and source-hash checks before and inside `withWrite`. That callback
   must acquire the same lock used by sync and bind the selected account/document. Results are
   domain records; the CLI/MCP adapter maps them to its output envelope.

Use a distinct collection namespace per provider/account. External file IDs are scoped by that
collection, so two providers can use the same file ID. The application chooses its database path;
these services never select the owner's store implicitly. Text changes/removal stale derived
memories while retaining owner notes and tags. Accepted facts change only through explicit fact
operations.

## A source from a manifest

A `files` CLI made from `wirecat.config.ts` can describe its source there instead of writing one.
`documentSourceFromManifest(source, { api, call, hooks })` (`@wirecat/cli-core/documents/cli`) reads the manifest,
checks it against the generated API (`parseDocumentManifest`: each operation exists and only reads, each call places
the value it needs, an unknown operation names the one most likely meant) and answers a `DocumentSource`:

| Field | What it says | Needs |
|---|---|---|
| `identity` | the call that names the account, and the paths joined by `:` (`["bot.workspace_id", "id"]`) | |
| `get` | one file by its id, and `map`: the paths of a row's id, name, parent or parents, URL, times, version, trashed, and which rows are folders | `"{id}"` |
| `children` | a folder's children, a page at a time by the operation's `pagination` (`childrenPage`); a row its map finds `trashed` is a deletion, as in `changes` ([trashed rows](#a-trashed-row-in-a-listing)) | `"{id}"` |
| `changes` | what changed since a time (`since`: `iso`, `ms` or `seconds`), with an overlap (`overlapMs`, ten minutes by default); a trashed row is a removal, and a row older than the since at `time` is left out | `"{since}"` |
| `deletions` | the documents deleted since a time, for a provider whose `changes` misses them (Linear's trash leaves `updatedAt` as it was): the id of each at `id`, a row older than the since at `time` left out; read in every round of changes from the same time, with the overlap of `changes` unless its own `overlapMs` says otherwise ([a deletions feed](#a-deletions-feed)) | `"{since}"` |
| `content` | the document's Markdown, at the path `markdown` of the answer | `"{id}"` |
| `reread` | a saved document read again while its `providerMetadata` has no value at `missing` (see below) | |
| `reads` | further calls by name, for the hooks | |

`call` is the CLI's `serviceApiCall`: the source's requests take the `api` group's transport, sign-in, headers and
refusals. A method the manifest does not describe, or that the provider does another way, comes from `hooks`: a
function given `read(name, slots)`, which sends a call the manifest names, `file(row)`, which maps a row, and `base`,
the source the manifest alone describes. Each method a hook gives wins over the manifest's. A source with no
`identity`, `metadata`, `children` or `content` from either is refused when it is built, and so is a change feed
with only one of `startToken` and `changes`. Every request the sync makes is then one the config names. A call paged by a next-page link is refused: a source
carries a cursor, an offset or a page number between rounds. A round of `changes` reads at most 100 pages; past them
it goes on next time from the newest row it read, which needs the call to list changes oldest first, and fails with
`source.changes-too-many` otherwise. A call in `reads` takes a name of its own: `identity`,
`get`, `children`, `changes`, `deletions` and `content` are the manifest's.

### A deletions feed

Each round of changes, the manifest's or a hook's, also reads `deletions`, and each id it names leaves the local
copy as `deleted` (`{ id, removed: true, gone: "deleted" }`). The change token must be a time in milliseconds, as
the manifest's own `changes` gives it; a hook's `changes` with another token fails the round as
`source.token-invalid`. A feed is refused when the source is built without a change feed to read it in, or without
`warn`. The deletions are read and listed first, so a row `changes` reads in the same round is the newer word and
wins. A provider may keep the feed to admins or a higher plan: a `permission_error` leaves the
round as the changes make it, and the source's `warn` (the run's, `DocumentSourceRun.warn`) gets
`source.deletions-unchecked`, which reaches the sync's `warnings` and `meta.issues` and says `sync --rescan` finds
them. Any other error fails the round, and the next sync reads the same time again.

### A full walk every so often

Some edits reach neither feed: on Linear, restoring a document from the trash leaves `updatedAt` as it was and writes
no audit entry, so the restored document stays out of the copy. A source whose feed misses edits like this sets
`rescanEvery` in its manifest (a duration with a unit, such as `"7d"` or `"12h"`, as cli-core's other durations are
written), or `rescanEveryMs` on a source built in code. A plain `sync` then starts a full walk, exactly as `--rescan`
does, once that long has passed since the last full walk ended. The walk goes on over the next plain syncs until it
ends, as a `--rescan` does, and is not started again in between. The sync that starts it says so in its answer:
`rescan: { why, every_ms, last_full_walk }`. The state records the end of each full walk in `fullWalkAt` (a first
sync, a `--rescan`, a changed scope or one started this way). A profile synced before `fullWalkAt` existed has none,
so its first plain sync after the upgrade walks in full: that brings back what was restored before. The manifest
refuses `rescanEvery` without a change feed, as a source without one walks in full on every sync anyway. Left out,
only `--rescan` walks again. A source with a complete feed (Drive) leaves it out.

The config also says what the `api` group and the source send with every request (`api.headers`, such as the API's
version; a header that could hold a credential is refused) and how fast (`api.pace`, with a slower pace for one
operation in `api.pace.operations`).

**Reading a saved document again.** A source that learned to read something later (a page's authors) gives
`reread(saved)`: the sync reads a saved document again though it did not change while `reread` says so, at most
`REREAD_BATCH` (50) a pass, so new edits are not held back. `content()` must give what `reread` asks for, or the
document is read again on every pass. So the manifest's `reread` is refused unless a hook gives `content`: the
manifest's own content saves no `providerMetadata`. Re-reads come after every real edit in the plan, so a run that
stops on its deadline spends it on the edits first.

cli-core checks `api.headers` and `api.pace` but does not apply them yet: the CLI passes them to its transport and to
`serviceApiCall` (notion-cli's `src/notion/client.ts`). An operation named in `api.pace.operations` is not checked
against the generated API.

## Walks over several syncs

A sync stops before its end and saves where it is; the next sync goes on from there. No size makes it fail.

- **One call is bounded.** A walk lists folders until it has counted `maxEntries` (each listing counts one, plus
  the entries it returns) or until `budget.take()` says no. The first listing of a call is always made, so a folder
  with more children than the bound still moves on. The budget is the run's `RunBudget`
  ([WC-LIFE-16](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/lifecycle.md)); the shared `sync` command passes
  `runBudgetOf(command)` as `budget` in its arguments, and the CLI hands it to `syncDocuments`. The budget is also
  asked before each file read and each picture download, and a stop there leaves the rest of the batch pending. The
  budget keeps a margin of
  5 s or more before the deadline, so a run shorter than that would never move: the first request of a call, a
  listing or a file read, goes ahead past a `deadline` stop (`RunBudget.first()`). Only one, only while the call has
  made no other request, and only while one request of the CLI's `requestMs` (2 s by default), plus 0.5 s to answer
  and save, still fits before the deadline itself. The budget judges this by its own clock, never by the sync's
  `now`, which tests fix. With `--embed`, the CLI passes the same `deadline` to `embedNotes`, which stops between
  batches at the deadline less its margin and answers `stopped` and `remaining`. A run whose last batch ends at the
  stop answers that it is done, and `remaining` counts the chunks the embed would still be given, in one query. When
  the CLI's answer carries `embeddings` with enrichment stopped by `enrichment.deadline` before it sent anything, the
  shared `sync` adds the `sync.longer` step: `sync --embed --timeout 15m`, `safe_to_auto_execute: false`.
- **The shared `sync` is cooperative and partial**, as the calendar and CRM syncs are. Without `--timeout` it gets a
  sync's deadline, 15 min in a terminal and 45 s over MCP, instead of a one-shot's 30 s, so its budget fits as many
  requests as that deadline allows (about 12 in 30 s with the 2 s default `requestMs`). A cancel is not cut from
  outside: the walk stops at the next folder on the run's `signal`, budget or not, the batch stops before the next
  file, and both keep their work.
- **The walk is saved through `saveWalk`** every 2 s and when the call stops: the folders still to list, the
  folders and files found. Only the fields of `SourceWalk` are used, so a CLI that validates the walk file with a
  strict schema keeps all of it, and accepts the optional `listing` and `deleted`. A round of changes is saved under the scope `<scope>:changes:<cursor>`, which names
  the cursor it started from.
- **The answer says the pass is not done:** `complete: false`, `stopped` (`entries`, `requests`, `deadline`,
  `cancelled`) and `walk: { folders_left, entries, listed }`. The shared `sync` command answers it as partial
  (`meta.complete: false`, exit 0) with the next step `sync.run`: the same `sync --limit`, safe to run unasked. A
  call that listed nothing and saved nothing gets no step.
- **A changed folder costs its direct children.** In a round of changes, each folder the feed names is listed once;
  a child folder the last finished pass already held is not listed again. **So a source must name in its feed each
  changed or new entry, or at least the folder it sits in directly.** A feed that names only an ancestor misses a
  file added two levels below it until a rescan. Drive's feed names the file itself; `documentSourceContract`
  checks this when the fixture gives `addNested`. A folder new to the scope (new, restored from the trash, or moved in from outside) is walked in full, so the
  files under a folder moved in are found though Drive's change feed names only the folder. Every page of a source
  whose pages are folders is listed when it changes.
- **`--rescan` goes on until it finishes.** It drops the cursor and any saved walk, and saves that at once, so the
  following plain syncs continue the new walk. Each `--rescan` starts over, so a loop runs it once and continues with a
  plain `sync`; `sync --help` says so. Work a dropped batch had saved to the
  index without the state knowing is removed when the batch is dropped, and the state is saved right after, so a
  call cut short does not remove it again.
<a id="a-trashed-row-in-a-listing"></a>
- **A row the listing puts in the trash is deleted; a row it leaves out is not.** A source may list rows in its trash
  (Linear's `includeArchived`) with `trashed: true`, the same signal the change feed gives. A walk (`children`,
  `childrenPage`, a saved query's `list`) removes such a document with the reason `deleted`, as a change would; a
  page with sub-pages (`isDocument`) is removed itself, and what is below it leaves as `unavailable`, as in a round of
  changes. A document a finished walk did not find stays `unavailable` with its text kept: absence is never a
  deletion. So a `--rescan` that first sees a trashed document removes its text then, where it used to keep it for
  good. A stopped walk saves the ids it found deleted in `deleted`, so the call that resumes it removes them as
  deleted too. That holds for a round of changes as well: a file the feed deleted before the round's walk stopped
  used to resume as `unavailable`, and now stays `deleted`. A CLI whose walk-file schema drops `deleted` removes them
  as `unavailable`, with the text kept. A source that sets
  `trashed` on nothing in a listing walks as before.
- **A folder gone since the walk saved it is dropped.** When listing a folder answers `not_found` (through
  `errorOf`), the engine reads the folder again with `metadata`. Only a second `not_found`, or the folder in the
  trash, drops it and what was below it from the scope, and the walk goes on. On any doubt (the folder is there, or
  the read fails another way) the call fails with the listing's error; the walk is saved, so the next sync lists the
  folder again, and a `--rescan` starts the walk over. A passing 404 therefore never removes a subtree.
- **A big folder is listed a page per step** when the source has `childrenPage(id, cursor?)`. Each page is one
  listing for the bound and one `budget.take()`. While the page gives a `cursor`, the folder stays on the stack with
  `listing` set to it, its child folders wait below it, and a stop saves it there, so the next sync asks for that
  page and no page is read twice. Without a `cursor` the folder is done. Only a 404 on the first page is checked with
  `metadata`, as above; a 404 on a later page can be a cursor the provider dropped, so the folder is listed again
  from its first page and nothing is dropped. So a source answers a cursor it no longer accepts with `not_found`
  through `errorOf` (Notion answers a bad `start_cursor` with 400 `validation_error`); any other error fails each
  later sync on that page until a `--rescan`. A CLI that validates its walk file must keep `listing`: without it a
  folder bigger than one call starts over each sync and never ends. A Notion database of 12 000 rows needs this to
  get past its first page over MCP (45 s); `documentSourceContract` checks that the pages list what `children()`
  does, each entry once.
<a id="a-source-without-a-change-feed"></a>
- **A source without a change feed** (Yandex Disk, WebDAV, S3) is a `FeedlessDocumentSource`: no `startToken`, no
  `changes`. Every sync
  is then a full walk of the selected folders: no folder is skipped as already walked, the cursor is `walked`, and a
  file is saved only when `changedSince` its last pass (version, time, name, parents). What the finished pass did not
  find leaves the copy as no longer visible, with its text kept ([history](#history-and-the-change-log)). A pass cut
  short removes nothing and goes on from its saved walk. A chosen folder that answers
  `not_found` is skipped as unavailable, and its documents leave the copy as no longer visible with their text kept.
  With a feed, the same root fails the rescan instead. On a path-addressed source a root moved on the provider
  answers `not_found` too, so its documents are no longer visible until the folder is chosen again under its new
  path. A file kept by name only is read again only once it changes, or, kept as `unsupported type: …`, once a
  newer version reads its type (`readableFile`). The cost is one listing of every
  folder per sync, so such a CLI keeps its folders selected rather than the whole account.
- **A source that addresses files by path** reads the path from the file the sync passes: `metadata(id, known)` (the
  folder as the last pass held it, for a root or a folder that answered 404), `children(id, folder)`,
  `childrenPage(id, cursor, folder)`, `content(id, maxChars, file)` and `bytes(id, file)`. Its ids stay stable ids
  (Yandex Disk's `resource_id`), so a moved file keeps its notes and tags; a root it cannot find by id is the CLI's
  to resolve from its own settings.
- **A source whose listing is slow lists several folders at once** with `parallelListings` (a whole number up to 8;
  one when unset): the folders at the top of the walk's stack, each charged to the run's budget before it starts.
  Results apply in stack order, so the walk files what a walk one folder at a time files, though not always in the
  same order. A folder stays on the saved stack until its listing is applied; when one listing of a batch fails, the
  others are kept and the walk is saved before the error, so the next sync lists only the failed folder again. The
  entries bound can be passed by the rest of a batch.
<a id="scans-and-pictures"></a>
- **Scans and pictures are read by OCR** in `documentLibraryCommands`, chosen by the profile's `read_scans`:
  `local` (the default: the `tesseract` program on this computer, Russian and English), `anthropic` or `openai` (the
  model `ai set` chose, only at `https://api.anthropic.com` or `https://api.openai.com`, and only with pictures
  allowed, `ai set --images`), or `off`. A CLI adds `DOCUMENT_SCAN_SETTINGS` to `settingsFor` so its config file
  takes the key; without it every profile reads locally. Local reading never falls back to a model, and nothing is
  downloaded: tesseract.js was left out because it fetches its language data from a CDN. A PDF whose `content()`
  answers `document.needs-ocr` (what `fileText` says for a file with no text layer) and a JPEG, PNG or WebP picture
  up to 25 MB (which a CLI keeps as `unsupported type: …`) are downloaded once more with `bytes()` and read page by
  page, at most 20 pages a file and 100 a sync; the rest wait for the next sync, and are refused before any download,
  so they take none of the run's budget. TIFF, HEIC and BMP stay by name only. With no reader (tesseract missing,
  the model not allowed, the PDF engines missing for a PDF), a scan is kept by name with the reason and the install
  hint, and is read on the first sync after that is fixed. A rate limit or an unreachable model leaves the file for
  the next sync too. A file OCR finds no text in stays by name, its reason naming the engine or model that read it,
  until it changes or another engine or model reads it. A picture OCR cannot read still gets its picture vector
  when the profile has `picture_search`, and a picture OCR reads gets both its text and its vector. The engine's name (`ocr:v1:tesseract@5.3.0:rus+eng`,
  `ocr:v1:openai/gpt-5`) is saved with the text, so another engine or model reads those files again, 50 a sync.
  Text OCR read once stays when a later reading fails or `read_scans` is `off`; only an edit of the file makes it old.
- **Not resumable:** one call of a source's `children()` (without `childrenPage`), one page of `childrenPage`, or one
  `changes()`. A folder listed with `children()` is listed whole, so a source caps its own listing (drive at 10 000
  entries in one folder or one change feed).

## History and the change log

The store keeps the earlier versions of every synced document, and a log of what each sync changed. The owner
asked for it (IDEA-2862 in cli-private's Notion roadmap): "what did this page say before, and what changed since
yesterday, even after a page is deleted".

- **A version is kept before every overwrite and every removal.** `saveFileNote` keeps the old text, title and front
  matter in `document_revisions` when any of the three changes, and the revision goes up by one. A removal keeps the
  last text the same way before the body is blanked. The first read of a catalog entry, which had no text, is not a
  version.
- **A removal has a reason**, `SourceRemoval`: `deleted`, `unavailable` or `unsynced`. Only `deleted` is a deletion,
  and only a source's own signal gives it: the file in the trash (`trashed: true`, in a change or a
  [listing](#a-trashed-row-in-a-listing)) or a change with
  `gone: "deleted"`. A bare `removed: true` in the feed, a 404 or a refusal when the content is read, a folder that
  vanished with what was below it, and a file a finished walk did not find are `unavailable`: the document leaves the live copy (lists and
  search) but keeps its text on its row, marked in `documents.removal`, and comes back as it was when the source
  shows it again. A file that left the scope because the owner changed the chosen folders is `unsynced`. So a source that can tell a deletion from a lost
  share (Notion's `in_trash` against a 404) sets `gone: "deleted"` on the first only.
- **The change log**, `document_changes`, has one row per document added, changed, deleted, unavailable, unsynced or
  restored, with its title and path at that moment. It outlives the document row. A trigger drops an account's rows
  with the account.
- **Retention** is the profile's `keep_versions_for_days`, 365 by default. A sync that completes its pass calls
  `index.prune` (`documentIngestion` gives it) with that age, under its lock. It drops older versions and change log
  rows of that account only, and blanks the text of a document unavailable for longer. The last version of a deleted
  document follows the same period. A CLI passes the setting as `keepVersionsForDays` to `syncDocuments`, and adds
  `DOCUMENT_HISTORY_SETTINGS` to `settingsFor` so its config file takes the key. `keepVersionsForDays(settings)`
  reads it.
- **The commands.** `documents history <document>` lists the versions, newest first, the current one marked, and
  `--revision <n>` shows one version's text and front matter. A removed document is found too. `changes` lists the
  changes since `--since` (default `1d`), up to `--until`, of the `--event` kinds asked for. Both are local reads, so
  an agent gets them as MCP tools like the other reads. `addDocumentCommands` mounts them when `history` is given:
  `run(fn)` opens the store read-only and hands `documentIngestion(...).history` and the profile's account, and
  `id(input)` reads an id or a link. `documentLibraryCommands` mounts them always. A CLI with its own `documents`
  group calls `addDocumentHistoryCommands(program, …)`, which adds `history` to that group.

## Verification

Service tests use real temporary stores and synthetic source ports with a non-Google folder type.
They cover two provider namespaces, interrupted discovery/download, batch continuation, account
mismatch, folder scope exit, metadata-only files, optional pictures, annotations and decision
history. Extraction tests cover preview, evidence, proposed saves and source changes at both
write boundaries. Drive's integration tests exercise its actual adapters against the packed Core
candidate. Tests do not contact a real provider or measure model accuracy.

## Sources added by hand

`store.notes.saveAddedSource` (`src/store/sqlite/added-sources.ts`) keeps what the owner hands memo himself: pasted
text, a file, or a page read from a link. Each is a `documents` row of the one account of provider `added`
(`external_id` `owner`), created with the first source, so word search, notes search, `search all` and meaning search
find it with no code of their own. The caller reads the file or page first (through the reader registry)
and passes the text with `read: "extracted"`, or an empty text with `read: "no-text"` (an image: found by its title
and subjects).

| Column | Holds |
| --- | --- |
| `external_id` | the caller's `sourceKey` when it gives one (`google-drive:<fileId>`); else `sha256:<hash>`: of a file's bytes; of the normalized text (NFC, whitespace folded) of pasted text or a page; of a page's address when it has no text |
| `content_hash` | the same hash, bare hex, as folder imports keep it |
| `kind` | `text`, `file` or `page` |
| `storage` | `text`, only the text; `copy` only when the caller passed `keepCopy` with the path of the copy it keeps (`local_path`) |
| `extraction` | `text`, or `none` for a source read as `no-text` |

1. **A repeat is the same document.** The unique key `(account_id, external_id)` finds it; only the new subjects are
   linked, and a `keepCopy` turns `storage` to `copy`. Under a `sourceKey`, changed text is the same document's next
   revision: the old text goes to `document_revisions` under its revision and `revision` goes up by one (`keepRevision`,
   the path folder files take), so the evidence signature changes and `knowledge.checkSources` reviews what cites it.
   The same text again changes nothing. `changed` says whether text was written. A key is `<namespace>:<id>`, a
   lower-case namespace other than `sha256`, and different keys never join, whatever their text.
2. **A live folder or Drive document with the same content is answered as `duplicateOf`**, and only the subjects are
   linked to it; nothing new is stored and `kept` is `null`. This holds when a removed added row of that content is
   still there; with no such document, the removed row is restored with the new read. A file matches a folder file by
   its bytes. Pasted text or a page matches a Drive document whose exported text it equals (Drive hashes that text as
   is). A Drive document never matches an uploaded PDF or Word file: Drive keeps no hash of the original file.
3. **The account is not a folder.** It is in `filesAccountSql` (so `account:` refs resolve and summarise), not in
   `FOLDER_PROVIDERS` or `DOCUMENT_ACCOUNT_PROVIDERS`: `saveFileNote`, `renameFileNote`, `dateFileNotes` and
   `deleteFileNotes` refuse it, so no folder sync can delete a source whose file is gone. A folder file of the same
   content does not join an added source either, since that file's removal would delete it. Its `files` row is named
   by `fileName`, else `title`, else the key.
4. **Subjects** are `about` links from the document. `by` names who adds it. The owner's links are confirmed, and an
   agent's proposal of the same subject becomes the owner's when he adds it. An agent's links are written
   unconfirmed (`origin` `suggested`), with the bot's name in `links.author` and its reason and model in
   `links.metadata`. The answer lists every subject the document is about.
5. **Removal** is `removeAddedSource(ref, "owner")`, the owner's alone: like a folder file's removal, the text goes and
   the row stays as deleted, so knowledge citing it sees its source gone. It answers the copy's path, if one was kept,
   for the caller to delete. Purging the account (`store.accounts.purge`) deletes its documents with it.
6. **Document transfer** does not carry the account: a transferred annotation that points at an added source is a
   missing binding.

**A copy is written only after asking.** `addedSourceKeyOf(content)` is the key, computed without the store;
`findAddedSource(content)` answers the live added source it repeats (`existing`) or the document it duplicates
(`duplicateOf`), writing nothing. The caller writes its copy of the file only when both are null, then saves with
`keepCopy`. Nothing says a copy is kept unless the row says `copy`.

**Reading one back.** `addedSource(ref)` answers a live added source: its document, `kind`, `url` as given, `fileName`,
`mime`, `size`, `kept` and the `copy` path when one was kept. Any other document, a removed source or another
reference is `undefined`, so a caller tells an added source from a folder document with it.

## Shared commands

`@wirecat/cli-core/documents/cli` (in `src/cli/documents/`: the domain layer `src/documents/` may not import
commands, the store or services) holds the commands every documents CLI shares, built over these services the way
`addCalendarCommands` and `addCrmCommands` are. `addDocumentCommands(program, options)` mounts them all, and
`documents history` and `changes` when `history` is given. One builder per group lets a CLI place its own groups between them (drive puts `transcripts` and `store` after
`status`). The CLI passes:

- **`words`**: its command, the provider in sentences, the store provider name and the word for the
  remote side. `mirrors sync --keep local|<remote>|both` maps `<remote>` to the engine's `remote`, and
  `identities link` takes `<remote>-id`. Texts that read differently for the provider go in `words.text`. Entity names
  and fields are the same in every CLI: `document` (views `imported` and `catalog`), `document_tag`,
  `document_relationship`, `document_identity` (`remote_id`, `provider`, `role` of `owner` or `last-editor`,
  `person`), `selected_folder`, `mirror`.
- **`output`**: its own envelope, keys and `--fields`. The builders answer through it and never print themselves.
- **Ports per group**, called when the command runs: the selected profile's store, its lock and principal, the
  provider's source and the item shapes. The builders never pick a profile, open a store or take a lock.
  `status`, `folders add|remove` and the mirror config stay the CLI's own code behind the port.

**`documentLibraryCommands(options)` fills every port at once** for a CLI with a plain source: the profile's files
under its state folder (`documentProfile`: `folders.json` with each chosen folder's metadata, `sync/state.json`,
`sync/walk.json`, one snapshot per document, and `sync.lock`), the shared store opened read-only for a read, the
account check (`claimDocumentAccount`: one provider account per profile) and the knowledge port. The CLI gives
`source(command, events, run)` (built inside cli-core's run, so each request lands in the run record), `ingestion`,
`idOf`, `isFolder`, a `documents list` `row`, its limits and `coverage`, and optionally `folder` (how `folders add`
reads what the user typed: Yandex Disk reads a path) and `browse`. It answers the commands to add to the program.
notion-cli and drive-cli predate it and keep their own wiring. `documentLibrary(options)` answers the same commands
without `sync`, and that sync as a step (`DocumentSyncStep`) for a CLI whose own `sync` brings the documents too: a
tracker's ([TRACKER.md](TRACKER.md#one-sync-with-documents)). The step answers what the shared `sync` would have, its
meta, next steps and lines for the person. A provider whose accounts hold documents beside another kind (`linear`,
`kinds: ["tracker", "documents"]`) is a documents account provider as Drive is.

The `documents` group the builders return takes the CLI's live subcommands (`get`, `create`, `update`, …), added after
the shared ones. `folders` takes the CLI's `browse`, which stays outside the shared contract. Catalog entries use the
`<id>.md` external ids the ingestion writes. Permissions, `--read-only`, the profile lock and MCP stay with the
CLI's run; the builders honour a global `--dry-run`.

- **`catalog tree`** reads each shown entry's children from the store, 1 000 a page, and asks about the branches it
  cuts at `--depth` 200 at a time. Any entry with children can be a root or a branch, so a page with sub-pages
  (`isDocument`, kind `file`) works. An entry in two folders is shown in full once and marked `repeated` at its other
  place. Over 10 000 entries the answer is `catalog.tree-limit`: name a smaller folder or lower `--depth`. The
  store's `parent` filter takes one id or several (`parent: [a, b]`, an entry under any of them) and scans the
  account's catalog once per read; asking about the 1 000 branches of a folder in a 12 000-entry account takes about
  0.06 s, 3.2 s when each parent was its own `OR` clause ([measured](https://github.com/WireCatLabs/cli-testing/blob/main/performance/documents/sync-scale/README.md)). Each read still scans the account. `catalog.get` and `catalog.list` of `documentIngestion` take
  an id with or without the `.md` the entries carry.
- **`mirrors watch`** polls the connection's `changes`. When the feed cannot go on from its cursor (expired, or
  over its bound), `changes` throws a `listing.too-large` CliError: watch then starts a new feed and checks every
  mirror once.

**Other people's text is marked for a scheduled agent.** A file on a drive is named and written by whoever shares it,
so the shared reads declare its fields with `marksUntrusted`
([WC-SECR-11](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/security.md#wc-secr-11--text-from-outside-is-made-safe-before-a-terminal-or-an-agent-sees-it),
[WC-SECR-21](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/security.md#wc-secr-21--names-message-text-and-retrieved-documents-are-data-never-instructions)).
In a run locked read-only with a mark (`schedule agent`), each such text comes between the run's markers; elsewhere
the answer is as before, and no answer gains a field. `DOCUMENT_UNTRUSTED` (`name`, `title`, `path`, `text`,
`description`, `excerpt`, a link's `target_text`, at any depth) covers `documents list|show|history`, `changes`,
`search`, `folders list`, a library CLI's `folders browse` and `catalog show|list|search|tree`, whatever the CLI's
row holds. `relationships list` marks only the link text written in the document (`targetText`): the rest of a
relationship is the owner's or an agent's.
`memories list|show|search` and `facts list|show` mark each one's `text` (`KNOWLEDGE_UNTRUSTED`), whoever wrote
it: a model's repeats the document's words, and the store cannot tell which of the owner's or an agent's did
([Facts, memories and what agents do](KNOWLEDGE.md#facts-memories-and-what-agents-do)). `identities list` marks the
`name` the provider shows for an account and the person's `name` beside it (`IDENTITY_UNTRUSTED`): the account's
holder chose it, and a CLI seeds a new person's name from it. `documents context` marks the same:
`document.title|text|path`, the links' `targetText`, `memories.text`, `facts.text` and `people.items.name|person.name`.
The notes and tags beside it are the owner's, as a note is in `search notes`, and `notes` stays unmarked.
`memories extract` and the other writes never answer a locked run, which refuses them.
`files sheets show` marks a sheet's name and its cells' values and formulas, `files documents show` the
paragraphs' text, and `mirrors conflicts show` the path, the three versions' text, the merge and each hunk.
`documents export` answers only the owner's own `--output` path, so it marks nothing.

A CLI with its own reads of the same text marks them itself: drive-cli's own `documents`, `catalog` and knowledge
commands, notion-cli's `documents get` and `folders browse`, yandex-disk-cli's `files` reads. It imports
`DOCUMENT_UNTRUSTED` (or `DOCUMENT_CONTEXT_UNTRUSTED` for a context answer, `KNOWLEDGE_UNTRUSTED` for memories and
facts, `IDENTITY_UNTRUSTED` for `identities list`) and `marksUntrusted` from `@wirecat/cli-core/documents/cli` and
wraps each such command: `marksUntrusted(command, DOCUMENT_UNTRUSTED)`. These lists name cli-core's fields; a CLI
whose rows use other names passes its own, such as drive-cli's `displayName` for an account.

`@wirecat/cli-core/documents/testing` checks both halves: `documentSourceContract` an adapter (pass `isDocument`
for pages with sub-pages, `change` to check the change feed, and `change` with `remove` for a source without one), and `documentCommandsContract` the CLI's mounted
commands over its fakes: every shared path, its effects, no override of a shared contract, and the answers by id.
`fakeDocumentSource` is a provider in memory, and the kit's own test runs both contracts over a reference CLI on a
temporary store.

<a id="push-local-files-to-a-provider"></a>

## Sync local files with a provider

`pushDocuments` keeps a local folder and a provider's native documents in step, both ways. The provider implements
`DocumentTarget`: which local paths it takes (`kindOf`), find-or-create of folders by an origin key, `create`,
`prepare` and `findByOrigin`. It persists `PushState` through `PushStatePort`, holds its profile lock and passes
`assertHeld`, and wraps each remote write in `guard` with its permission checks and write journal.

1. Every mirrored file is read back from the provider on each run, changed locally or not: a remote edit is
   found only by reading. `planPush` is the local plan alone (`dryRun`, a status command).
2. A create saves a pending origin key first; the provider stores it on the remote file. After a crash, the next
   run finds the file with `findByOrigin` and updates it instead of creating a second one.
3. `prepare` merges the remote and the local file against the snapshot the last sync recorded, and returns a
   conflict, `missing`, `unchanged`, or the merge: new `local` content and a `write` step that reaches the remote
   only when `remote` is true. A conflict lists its parts and, when the provider knows them, when and by whom the
   remote last changed; the engine adds the local file's time. A conflict never reaches the write journal, and the
   run goes on with the other files. `keep` (`local`, `remote`, `both`) settles conflicts instead.
4. The local file is written before the remote: through a temporary file beside it, keeping its mode, and only if
   it still has the hash this run read — a file saved meanwhile is reported, not overwritten. Right after it, the
   provider's `afterLocal` snapshot is saved: both sides as the remote is now. If the remote write then fails, the
   next run sends only the file's changes against that, so a conflict settled by `keep` is not met again.
5. Nothing is deleted remotely. A file deleted locally is an orphan; a file deleted remotely is missing and is
   created again only with `recreate`.

A CLI that mirrors folders does not need to write the loop itself. `syncMirrors` runs `pushDocuments` for each
`Mirror` (`id`, local `path`, remote `folder`) under one lock and returns the items plus one `mirror.partial`
issue per mirror with conflicts, missing files or errors, so the command can answer `complete: false` and then
fail. Conflicts come back through `conflictReport`, with the remote side named as the app names it (`google`).
`fileMirrorState(dir, mirror, principal, kinds)` keeps each mirror's state in `<dir>/<id>.json` (0600) and refuses
an invalid file instead of resetting it; `mirrorId(root, folder)` is the id; `mirrorStatus` is the local plan of
each mirror. The CLI keeps its commands, its config and its target.

`watchMirrors(sync, options)` keeps mirrors in step until its signal aborts, calling `sync` (usually `syncMirrors`)
with only the mirrors that need it: all at start; one whose files were saved, after `quietMs` (2 s) without another
save, and only if its files differ from the state, so the files a pull writes start no cycle; the ones
`remoteChanges` names at each poll (`pollMs`, 60 s); any whose files differ at the periodic check (`checkMs`, 5 min),
for file events the system dropped; and all of them at the full run (`fullMs`, 30 min), for remote changes listed
late. It yields one event per cycle with its triggers and mirrors, and a failed cycle as an error whose mirrors are
tried again at the next poll. The CLI takes the lock inside `sync`, so a manual sync can run between cycles.

<a id="sync-plain-files-with-a-provider"></a>

### Plain files, both ways

A remote folder that keeps files as they are (Yandex Disk, a WebDAV share) uses the whole-file engine,
`syncFileMirror`, instead of `pushDocuments`: it copies whole files, merges only small text files both sides
changed (point 13), and reads the remote with one listing per run instead of one read per file. The provider implements `FileTarget`:

```ts
interface FileTarget {
  identity(): Promise<string>
  list(
    root: string,
    signal?: AbortSignal,
    options?: { excluded?(path: string): boolean; from?: string },
  ): Promise<{ rootId: string; files: RemoteFile[]; complete: boolean; next?: string } | undefined>
  exists(path: string, signal?: AbortSignal, id?: string): Promise<boolean>
  download(path: string, into: string, signal?: AbortSignal): Promise<void>
  upload(path: string, from: string, expect: Expect, signal?: AbortSignal): Promise<RemoteFile>
  trash(path: string, expect: { sha256: string; md5?: string }, signal?: AbortSignal): Promise<void>
  ensureFolder(path: string, signal?: AbortSignal): Promise<void>
  rewrites?: boolean
  revision?(signal?: AbortSignal): Promise<string>
}
type Expect = { absent: true } | { sha256: string; md5?: string }
```

`list` returns each file's path relative to `root`, its `id` (kept across a move and an overwrite), `size`, `sha256`
(the plain hash of the content), `md5` and `modifiedAt`, plus the root folder's own id and `complete`, false when a page was skipped or a cap was hit. Files at paths
`excluded` names are listed too, so a file moved there is found by its id, but count toward no cap. An incomplete
listing that can go on later (a run's deadline stopped it, a page failed) returns `next`, its position, such as an
offset; given back as `from`, the listing returns only the files from there on. `exists` reads one
path directly, false only when the provider says the file was deleted. An answer that cannot tell a deletion from lost
access (Notion's 404, which may mean "no longer shared") throws, and the file is `unknown`, never trashed. It gets the
file's `id` from the last sync too, so a provider that keeps ids across a move asks by it: a file moved out of the
folder is still there, not deleted. The other calls take the remote path, `root` joined with the relative path. `download` and `upload` stream a local file, so a file of any
size takes the same memory. Every write is conditional on what the listing saw: `upload` and `trash` refuse with a
`conflict` error when the remote file is not as `expect` says; a provider without an atomic check reads the file
just before the write ("checked just before the write": an edit landing after that read is not caught). An editing
command reuses the same call, `upload(path, file, { sha256: whatWasDownloaded })`.

A remote that keeps its own form of the text it is sent (Notion turns Markdown into blocks and gives back its own
Markdown) sets `rewrites: true`. Its `upload` returns the hash of the bytes `download` gives, and `list` must hash the
same bytes. When an upload reads back with another hash than the file sent, the engine downloads that form into the
version store, keeps the local file's version, and writes the form into the local file while it still has the hash
that was sent (a `changed` event, `remote-to-local`, and the path in the result's `rewritten`). Both sides then hold
the same bytes, so the state keeps one hash per path and a merge one base. A local file saved during the upload stays
as it is, and the next sync sends it. A conflict's resolution does the same with the final content. Without
`rewrites`, such an upload is a conflict (`upload.mismatch`).

1. Each path is compared three ways: the local file now, the remote file now and the last sync (`FileEntry` in the
   state). A change on one side is copied to the other. The same content on both sides is adopted without a
   transfer, so a first sync of two identical trees moves nothing. A small text file both sides changed is merged
   (point 13). Other different content on both sides, a merge that conflicts, or a deletion on one side against a
   change on the other, is a conflict: never overwritten, reported with each side's time and
   size, and the run ends with a `mirror.partial` issue. `keep` settles conflicts on a later run: `local` and
   `remote` pick a side; `both` downloads the remote version beside the local one as
   `name (conflict YYYY-MM-DD <remote>).ext`, then sends both. The copy enters the state only once its upload
   returns, so a failed upload leaves it to send next time, never to delete.
2. A deletion crosses sides into a trash: the remote's (`trash`, with the expected hashes) or
   `<root>/.wirecat-trash/YYYY-MM-DD/`, which is hidden and so never synced. A run that would delete more than 10
   files (`MAX_DELETIONS`), or replace more than 50 existing files on either side (`MAX_REPLACEMENTS`: an upload over
   a remote file, a download over a local one, `keep: "both"`, a merge), stops before any write unless `allowDeletions` and
   `allowReplacements` cover the counts, however large the mirror. The stop is not thrown: the mirror's result has
   one error at path `.` with `code: "confirmation_required"` and `reason` `mirror.too-many-deletions` or
   `mirror.too-many-replacements`, plus `tooManyDeletions` and `tooManyReplacements`, so `syncFileMirrors` goes on
   with the other mirrors and a watch reports the stop at every cycle that syncs the mirror. The message names
   every count over its limit and the one command that allows them all. Replacements get the higher bar because the
   store keeps every content they replace. A dry run reports the counts without stopping. `hints` (`preview`, `repin`, `sync`,
   `allowDeletions`, `allowReplacements`, `exclude`) are the app's commands in these messages, with `<id>` (the
   mirror's `id`) and `<count>` filled in. The defaults use the vocabulary's words, which `cli-dev lint` accepts:
   `--allow-deletions <count>`, `--allow-replacements <count>` and `--ignore <path>`. An app that keeps a `--replace`
   switch passes `allowReplacements: Number.POSITIVE_INFINITY` for it and its own `allowReplacements` hint.
3. A remote file found at a new path with the same `id` is renamed locally. A local rename is a deletion and a new
   file.
4. A local file whose size and mtime match the state is not hashed again (`scanLocal`'s `known` lookup). A local
   write goes through a hidden temporary file and lands only if the file still has the hash the run read, or is
   still absent for a new file; a download whose content does not match the listing's `sha256` never lands. An
   upload that reads back with another hash is a conflict, unless the target `rewrites` (above). A new file, a local rename and a local trash land with a
   hard link, or, where the file system has none (exFAT, FAT, many FUSE and SMB mounts) or the link would cross
   devices, with a copy into a file the sync creates exclusively, so a name that is taken fails and is never
   touched; either way nothing is overwritten.
5. A symbolic link is never followed. Before every local write, rename or trash, each folder from the root down to
   the file (and the trash folder) is checked; a link there fails that file with `mirror.symlink`. A file of the last
   sync that sits under a link, such as a synced folder replaced by one, is `unknown`, never deleted. A remote path
   with an empty, `.` or `..` segment or a NUL (and, on Windows, a backslash) is refused as an error. A file of the
   last sync whose id now has a refused path is `unknown`; other deletions are still proven.
6. A crash at any step is settled by the next run's listing: the same content on both sides is adopted, a file gone
   from both is forgotten, so nothing is written twice and nothing is lost. `pending` in the state only names a
   download's temporary file, removed at the next start, and a write that ended `outcome_unknown`, which is never
   retried within the run. A download that fails while the process lives clears its entry once the file is missing or
   whole (the remote's or the replaced content); a partial copy that could not be removed keeps it. The leftover
   temporary file is removed only after the same symbolic-link check as any write; one under a link is left. A
   download of a new file whose copy into place was cut off may leave a partial file under its name (`pending` says
   `created`): while that file has neither the remote's nor the last sync's content, its entry stays and the path is
   a conflict whatever `keep` says; moving the file away lets the next run download it. A download that replaced a
   file renames it into place whole, so it is never taken as cut off. The state is saved at the end and, during the
   run, at most once a second per 10,000 entries.
7. A file counts as deleted on a side only when the last sync saw it, the side's listing is complete, and the side's
   root is the same folder: the remote root has the id it had at the first sync; the local root exists, is a folder
   with the device and inode recorded at the first sync, and is not empty while the state has files (an unmounted
   drive reads as empty; the error says to mount it, or to add a file or remove the mirror's state when the files
   really were deleted). A file missing from an incomplete listing is reported in `unknown` and nothing is deleted
   for it. A file missing from a complete listing is deleted locally only once `exists`, read after the listing,
   says nothing is there: a listing read in pages can miss a file that moved while it was read, and a provider's
   flat listing may lag. A file `exists` finds, or cannot answer for, is `unknown`, and these checks come before the
   guard counts deletions, so a skipped page never reads as a mass deletion. No retry loop waits for the remote to
   stand still, so a remote that changes all the time (a phone uploading photos) still has its deletions proven. When a root fails, the run does nothing, reports every file of the state in `unknown` and the root
   problem in `errors` (path `.`), even at a first sync. Either way the run is partial. A file the last sync did not
   see is never a deletion. Hidden remote files are skipped as local ones are.
8. A root that was replaced (the remote root has another id, or the local folder another device or inode) blocks
   the mirror until the owner confirms it is the right folder: `repin: true` (a CLI's `--repin`, named in the
   error) records the new identity and runs a first sync: identical files are adopted, one-sided files copied,
   different ones reported as conflicts whatever `keep` says, and nothing is deleted in that run. Only a mirror whose
   root was replaced is re-pinned: `syncFileMirrors` with `repin` leaves the state of every other mirror as it is. A
   root that is gone, or a local folder that is empty where the state had files, still blocks.
9. `dryRun` lists the remote and returns the `plan`; it writes nothing on either side and saves no state.
10. `exclude` (a `Mirror`'s `exclude`) takes globs: a pattern without `/` is a name at any depth (`node_modules`,
    `*.iso`), one with `/` a path from the root (`/Camera`, `Work/**/build`); `*` and `?` stay within a name, `**`
    crosses folders (`excludedBy`; `exclusionPattern` checks one). An excluded path is absent by filter, never
    deleted: it is skipped on both sides, and its entries are dropped from the state at the end of the run, so adding
    an exclusion trashes nothing and removing one later syncs the path as a new folder. A synced file moved into an
    excluded folder on the remote is renamed there locally, then left alone.
11. Before writing, the run checks free space (`space`, `statfs` by default): downloads land under the root, and
    the store keeps what they replace. When a drive would keep less free than a tenth of what the run writes there
    (at least 100 MB, at most 1 GB), the run stops with one `mirror.no-space` error at path `.` (`noSpace` says the
    drive, the bytes needed and free); a dry run reports it. The local scan takes at most 100,000 files
    (`maxFiles`), and so does a listing that spans runs.
12. A listing too big for one run goes on in the next. An incomplete listing with `next` is kept in the state
    (`listing`: the root's id, when it started, `next` and the files so far), saved before any refusal, so a guard
    stop or a full drive does not list the same pages again. The next run asks for `from: next` and merges: this
    run's files win over the saved ones by path and by id, so a file met twice as pages shift is kept once, and a
    file moved between runs once, at its new path. Until the listing completes the run is incomplete, as point 7
    says, while what it has listed already syncs. Once a run completes it, every check of point 7 runs on the merged
    files, and the saved progress is cleared only after the guard and the space check let the run through. A saved
    listing is started over when it is more than 7 days old, when the root now has another id (its pages went on in
    another folder), when the run returns no `next`, or when the merged files pass `maxFiles` (100,000). A moving
    revision does not restart it: a remote that changes all the time would never finish. Offset pages can skip a
    file that moved while they were read, over runs as within one: a skipped file at its old path is still read
    with `exists` before a local deletion, and one that moved is trashed at its old path and downloaded at the new
    one on a later run, kept in the version store meanwhile. A saved file the remote changed or deleted since its
    page only makes a conditional write fail as a conflict. A dry run goes on from the saved position and saves
    none.
13. A text file both sides changed is merged, in every mirror: `.md`, `.markdown`, `.txt`, `.csv` and `.tsv` up
    to 1 MB on every side (`mergeable`, `MAX_MERGE_BYTES`). The base is the last synced content, which the store
    keeps for each such file after its upload, download or adoption (an unchanged file of a mirror synced before
    merges gets it at the next run); a base the store lacks makes the file a conflict, as before. The plan shows a
    `merge` step, counted as a replacement for the guard and as the three contents for the space check. The run
    keeps the remote content (downloaded unless the store has it) and the local one, and merges the three from the
    store with `mergeText`: a line-level three-way merge on the bytes (read as latin1, so any 8-bit encoding, CRLF,
    a byte-order mark and a missing last newline pass through), where changes with at least one unchanged line
    between them merge, the same change on both sides merges once, and lines both sides changed differently
    conflict, as do changes on neighbouring lines (as in Git: two edits that read fine alone can read wrong
    together). Markdown that conflicts by lines gets a second try with `mergeBlocks` and `spliceMarkdown` (a tick
    and a text edit on one item no longer collide, edits to neighbouring blocks still conflict), taken only when
    the remote's text is exactly what its blocks write over the base, so a change the
    blocks cannot see (front matter, a link definition, `_` for `*`) is never dropped. A merge writes the result
    locally while the file still has the scanned hash, saves the entry as the remote now is (with a local size no
    file has, so the next scan hashes the file), then uploads expecting the listed remote: a crash before the upload
    leaves a local change the next run sends, one after it an identical pair the next run adopts, and neither merges
    twice. The result lists it in `merged`; the log has one `merged` event, direction `both`. A merge that conflicts
    is a conflict with `parts` (each stretch's base, local and remote text) and its three contents kept; `keep`
    still settles it, whole file, as before. A NUL byte or a UTF-16 byte-order mark makes a file a conflict.
14. Each run records its conflicts in the state (`conflicts`, by path: reason, time, the three hashes, the listed
    remote file, `kept`), replacing the last run's. The same three contents are not downloaded or merged again at
    the next run or watch cycle. `listFileConflicts(mirrors, stateOf)` lists them; `showFileConflict` returns the
    three versions (text when kept), whether the local file changed since, each changed stretch of the line merge
    (`hunks`, with `kind` `local`, `remote`, `both` or `conflict` and the base line) and `merged`, the whole file with
    Git's markers, a start for a final version. `resolveFileConflict` settles one, under the sync lock and through
    `guard`, with `keep` (`local`, `remote`, `both`: the remote's version lands beside the local one, as a sync's
    `keep: "both"`) or `file`, the final content's local path. It refuses with nothing written when the local file
    no longer has the recorded hash, or the remote not the recorded one: the remote is written first, by an upload
    or trash that expects that hash, then the local file while it still has its own. Both sides get the final
    content, the entry is recorded, the conflict removed, and a `resolved` event logs it. `fileConflictsCommand`
    (`@wirecat/cli-core/cli/documents`) mounts them as `mirrors conflicts list [id]`, `show <id> <path>` and
    `resolve <id> <path> (--keep local|<remote>|both | --file <file>)`, `--file` owner-only, with the app's mirrors,
    state and stores as its helpers. Its `connect(command, mirror, body)` runs `body` inside the app's run (its
    `--timeout`, run record and request log) with the connected target, so `resolve` writes only inside it.

    `fileMirrorsCommand` (`@wirecat/cli-core/documents/cli`) is the whole `mirrors` group over this engine, so a
    file CLI mounts one command instead of writing its own: `add <folder> <path> [--ignore <path>]`, `list`,
    `status [id]`, `preview [id] [--keep]`, `sync [id] [--keep] [--allow-deletions <count>]
    [--allow-replacements <count> | --replace] [--repin]`, `watch [id] [--every]`, `update <id> [--ignore] [--clear]`,
    `remove <id>`, `versions list|restore` and the conflicts above. The app gives its identity, the service's name,
    the remote's word (`disk`, `notion`), what a mirror pairs a folder with (`place`: `Yandex Disk folder`,
    `Notion page`), the text and examples of `add`'s remote argument, the profile, its state
    folder, `keepForDays` (`keepVersionsForDays(settings)`), `connect(command, body, { unbounded })` (the app's run
    with the target and `root(input)`, which turns `add`'s argument into the folder the mirror saves and its id, and
    refuses anything else), `writeGuard(command, extra, ask)` and `keysOf({ action, side })`, the keys each write
    checks beside the command's own. The group keeps one guard per set of keys and asks once for a key the owner
    allowed in the run. The files stay where ydisk kept them: `mirrors.json` in the profile's state folder (`id`,
    `path`, `folder`, `account`, `exclude`), and `mirrors/<id>.json`, `mirrors/<id>.versions/` and `mirrors/sync.lock`.
    A target that `rewrites` writes the remote's form into the local file through `guard` as a local `update`, the
    same attempt a download over a local file makes: an app whose keys for a local update would ask at every upload
    maps that write to no key. A target without `revision` is listed at every `watch` poll, so such an app sets a
    longer `every`.

`versions` (`fileVersions(dir, now, keepForDays)`, with `dir` under the profile's state folder, one per mirror, never inside the
mirrored folder) keeps every content before the sync overwrites or deletes it, on either side, in
`<dir>/objects/<sha256>`: the local file before a pull, `keep: "remote"` or a crossed deletion, and the remote file
before an upload replaces it. A remote content the store lacks is downloaded into the store first (`keep` takes a
writer, such as the target's `download`); one whose hash no longer matches the listing fails the file with
`mirror.remote-changed`, a conflict. `keep: "both"` keeps the remote side from its local copy, or from the remote
when the copy was edited meanwhile. A remote deletion downloads nothing: the provider's trash holds the content, and
deleting a large folder must not fetch it all. Its log event names the hash, and says `oldIn: "remote-trash"` when the
store does not hold it. When the store cannot keep a content (a full disk during the download included), the file
fails with `mirror.version-not-kept` and nothing is replaced. Each change is appended to `<dir>/log.jsonl`: path,
event (`created`, `changed`, `deleted`, `renamed`, `merged`, `conflict`, `resolved`), direction (`both` for the last
three), old and new hash, `from` (the side `old` was kept from), size and time; a merge, a conflict and a resolution
name their contents in `parts` (`base`, `local`, `remote`), and a resolution says how in `resolution`. Retention,
applied after each sync under its lock: a content stays while a log event newer than `keepForDays` (the profile's
`keep_versions_for_days`, `keepVersionsForDays(settings)`, 365 by default) names it; the last
content of a path whose newest event is a deletion, every content a merge, a conflict or a resolution names, and the
last synced content of each mergeable file (`prune(pinned)`, the next merge's base) stay for good. A content no event
names (a crash between keeping it and logging the change) stays as long after it was last kept; one that vanishes
while prune runs is skipped. Call `versions.prune()` only under the sync lock. `versions.read(sha256)` returns a kept
content's bytes, for the text a merge reads whole.
`versions.list(path)` lists a path's events with `available` (bytes still kept) and, for a merge, a conflict or a
resolution, `versions`: each content with its role (`base`, `local`, `remote`, `result`) and whether it is kept; `restoreFileVersion(root, path,
sha256, versions, lock)` puts one back under the same lock as a sync, keeping the current file first, and the next
sync sends it. `versions.dir` is the store's folder, whose drive the free-space check reads.

The lock is either what `acquireLock` returns (its `held()` is checked before every write; a lost lock fails with
`profile.busy`) or any `{ assertHeld, release }`. `skippedName(name)` is the rule for hidden files, `node_modules` and
editor leftovers, so a target can skip them while it lists.

`guard` wraps every write with its `action` (`create`, `update`, `folder`, `delete`, `move`) and `side` (`local` or
`remote`), so the CLI maps overwrites and both trashes to its delete permission. `syncFileMirrors` runs the engine
for each mirror under one lock, as `syncMirrors` does; `fileSyncState(dir, mirror, principal)` keeps the state in
`<dir>/<id>.json`; `fileMirrorStatus` lists local changes and deletions without asking the remote. For
`watchMirrors`, pass `localChanges` (the mirrors whose `fileMirrorStatus` lists anything) instead of `kindOf` and
`stateOf`, and `remoteChanges: fileRemoteChanges(target)`: it reads the target's `revision` at each poll and lists
only when it moved; a target without one is listed at every poll.

For documents with structure, `markdownBlocks` (async; the parser loads on first use) parses Markdown into `Block`s
(headings, paragraphs, bullet, numbered and checklist items, code, quotes, tables, images, rules) with inline marks.
The provider maps its own document into the same blocks and writes only `diffBlocks(current, next)`, so unchanged
paragraphs keep their comments and formatting.

`mergeBlocks(baseLocal, baseRemote, local, remote, keep?)` is the three-way merge. Blocks line up by shape, ticks
left out, so a checklist tick never collides with a text edit: each tick follows the side that changed it, the
remote when neither did. Changes to different blocks merge; the same change on both sides merges once; a stretch
both sides changed differently is a conflict. The provider's snapshot keeps both the blocks it wrote and the local
blocks they came from; when those two no longer line up, the merge returns `unaligned` and the provider reports a
conflict rather than guess. A field the provider cannot read back must stay out of its blocks, or that block would
differ on every sync.

`spliceMarkdown(text, next, normalize)` writes the merge back into the Markdown file: only the lines of blocks that
differ change (a tick is flipped inside its line), so the rest keeps its markers, spacing, line endings and
byte-order mark. The result is parsed again and must read as `next`; otherwise it returns undefined and the caller
reports a conflict instead of writing. `blocksMarkdown` writes blocks as Markdown that reads back as the same blocks.

A service that keeps HTML, such as a blog (WordPress, Ghost), converts with `htmlToMarkdown` and `markdownToHtml`
(async; loaded on first use). Both treat the body as untrusted: comments (WordPress's block comments, Ghost's card
comments), scripts, styles, frames and event attributes go, Markdown's raw HTML is not written, and a link or image
whose scheme is not http(s), mailto or tel keeps only its text. Markdown that went through HTML once comes back the
same; the tests run on real WordPress and Ghost posts in `test/fixtures/posts/`. HTML that went through Markdown does not:
embeds, frames, classes and block comments are lost, so a CLI that reads a post, edits it and writes it back
flattens it. Such a CLI warns or refuses to write back a body that had them.

<a id="write-one-file-at-the-hash-read"></a>

### One file written at the hash it was read at

An agent that edits a file reads it, then writes the whole file back. `guardedFileWrite` (`@wirecat/cli-core/documents`)
writes over the content the caller read and nothing else, through the same `FileTarget` and `fileVersions`:

1. A file at the path needs `expected`, the sha256 the caller read; none is a `validation_error` that says how to read
   it. No file at the path needs no hash, and the upload goes with `{ absent: true }`.
2. The current content is downloaded into the profile's version store, under its state folder and never in a mirrored
   folder. Its hash is the proof: another one is `conflict`, reason `mirror.remote-changed`, with the command that
   reads the file again, and nothing is uploaded.
3. The target's `upload` checks `{ sha256: expected }` again. Few providers have a conditional upload, so most check
   just before they send, and a change landing between that check and the upload is not caught. A target that can
   have the provider check it (Yandex Disk replaces through a temporary file and a delete at the md5) does so. What
   the write replaced is kept and logged (`changed`, `from: "remote"`), so the write can be undone. A `conflict` the
   target raises with a reason of its own other than `mirror.remote-changed` (`upload.replace-interrupted`) reaches
   the caller as the target worded it, here and in a mirror's sync, since it says what was done.
4. A target whose replace gives the file a new id calls `rekeySyncedDocument` (`@wirecat/cli-core/documents/cli`)
   after it, with the CLI's documents ingestion: the synced copy moves to the new id (`renameFileNote` with
   `fold`), so the owner's tags, the notes about it and its links follow the file. A sync that ran in between and
   filed the file anew is folded into the old document. A failure only warns: the write already happened.

The answer is the file as the remote now has it and the replaced sha256. The store's retention is not run here: it
runs under a mirror sync's lock.

`addFileUpdateCommand(files, helpers)` (`@wirecat/cli-core/documents/cli`) adds
`<files> update <path> (--text <text> | stdin) [--expected-fingerprint <sha256>]` to the CLI's own files group. It is
a remote write, so the MCP catalogue lists it as one and a global `--dry-run` previews it. The CLI passes `words`,
`output`, `path` (what the user typed as the target's path), `reread` (the command that shows the file's sha256),
`stdin`, and `write(extra, act)`: its own write path, with its permission key for the command and `extra`, which is
`files.delete` (or `deleteKey`) when a file is replaced, as an upload with `--replace` asks. `act` takes the signed-in
target and the profile's version store. The answer has `path`, the new `sha256`, and `replaced` with the old sha256 and
`kept_at`, the kept copy, or `null` for a new file. An empty stdin, which is what an agent over MCP has, is a missing
`--text`. A `.pdf`, `.docx` or `.xlsx` path is refused (`file.not-plain-text`): a read gives the text extracted from
it, and writing that back would replace the document with plain text.

**A truncated or extracted read carries no fingerprint.** The sha256 that `--expected-fingerprint` takes is a promise
that the caller holds the whole file. A CLI's own text read (`files show`) gives it only beside the file's complete
text. When it cuts the text (`truncated: true`) or answers text extracted from a PDF, docx or xlsx, it leaves the
sha256 out, so an agent has nothing to pass to `update`; an Office file is edited with the commands below, whose
`show` gives the sha256 of the file itself.

<a id="edit-office-files-in-place"></a>

### Office files edited in place, and earlier versions put back

`addFileEditCommands(files, helpers)` (`@wirecat/cli-core/documents/cli`) mounts, under the CLI's own files group, the
`update` above and:

| Command | Effects | What it does |
| --- | --- | --- |
| `sheets show <path> [range]` | remote read | the stored cells of an .xlsx (value, type, formula, format), with the file's `sha256` |
| `sheets update <path> <range> --values <json> --expected-fingerprint <sha256> [--replace]` | remote write | writes JSON rows of values from the range's first cell |
| `sheets create <path> --values <json> [--name <name>]` | remote write | a new .xlsx from rows, or several sheets; formulas and bold cells |
| `documents show <path>` | remote read | a .docx's paragraphs by index, with style, `editable` and `reason`, and the `sha256` |
| `documents update <path> --payload <json> --expected-fingerprint <sha256>` | remote write | replaces, inserts or deletes paragraphs |
| `documents create <path> --payload <json>` | remote write | a new .docx from paragraphs (bold and italic runs) and tables |
| `history <path>` | remote read | what this profile's writes and syncs replaced in the file, from the version store |
| `restore <path> [version] [--expected-fingerprint <sha256>]` | remote write | puts a kept version back; with no version, the CLI's trash restore |

The names are the ones cli-base's vocabulary has: `sheets` and `documents` are resources, `history` is a view, a range
and a version are arguments, and `--values`, `--payload` and `--replace` are its flags. A range is `Sheet1!A1:C10`,
`'My sheet'!B2`, a sheet's name, or `A1:C10` on every sheet; an update may leave the sheet out when the workbook has
one. `--values` is rows (`[["Total", 42], [null, true]]`, null empties a cell); a range of more than one cell must
have their shape. A text is written as text, even one that starts with `=`, and a formula cell is refused
(`office.formula-cell`) unless `--replace`. `--payload` is a list of `{index, text}`, `{insert_after, text,
style_from?}` and `{delete}`, by the indexes `documents show` gave (`insert_after: -1` puts it first).

An edit downloads the file, refuses another sha256 than `--expected-fingerprint` (`conflict`,
`mirror.remote-changed`, naming the `show` that reads it again), runs the Office editor from
[`@wirecat/cli-core/office`](../../src/office/index.ts), and writes the result with `guardedFileWrite`: the file is
checked again, the replaced content is kept, and the write asks `files.delete` (or `deleteKey`). The editor's refusal
(a tracked change, an image, a formula, a table header, …) passes through with its `office.*` reason, and nothing is
uploaded. The answer is the update's (`path`, `sha256`, `replaced`) plus `changed` and `calc_chain_dropped` for cells,
or `paragraphs` (`replaced`, `inserted`, `deleted`) for a document, and `warnings`: a replaced paragraph whose mixed
formatting became its first run's, or a replaced formula after which Excel rebuilds its calculation order. A file over
64 MiB is refused (`file.too-large`): the editors hold it in memory.

<a id="create-office-files"></a>

#### New Office files

`sheets create` and `documents create` build the file with `createXlsx` or `createDocx` from
[`@wirecat/cli-core/office`](../../src/office/create.ts) and write it with `guardedFileWrite` as a new file: no
fingerprint, and the write asks only the command's own permission key, as `update` of a new file and a provider's
`upload` without `--replace` do. A file already there is refused before anything is uploaded (`conflict`,
`office.file-exists`, naming the `show` and the `update` that change it), and the provider's absent-file check catches
one that appears during the write. The path must end in `.xlsx` or `.docx` (`office.wrong-format`).

`sheets create` takes `--values` in one of two shapes, told apart by their first level:

- rows from A1, as `sheets update` takes them, for one sheet named by `--name` (`Sheet1` without it):
  `[["Item", "Cost"], ["Rent", 950]]`;
- several sheets, each with its own name and rows and `header: true` for a bold first row:
  `[{"name": "Budget", "header": true, "rows": [["Item", "Cost"], ["Rent", 950]]}, {"name": "Notes", "rows": []}]`.
  `--name` is refused beside it.

A cell is a text, a number, a boolean, `null` (empty), `{"formula": "SUM(B2:B3)", "bold"?}` or
`{"value": "Total", "bold"?}`. A text stays text even when it starts with `=`, inside `{value}` too: a formula is only
the explicit `{formula}`, so text from an untrusted source never becomes one. The formula is written without a result
and the workbook asks for a full calculation on open (see [Editing Office files](../office.md#new-files)).

`documents create` takes `--payload`, the body in order:

- `{text, style?, bold?, italic?}`, a paragraph in one format;
- `{runs: [{text, bold?, italic?}], style?}`, a paragraph whose parts differ;
- `{table: [[cell, …], …], header?}`, a table of texts (a number is written as text), its first row bold and repeated
  on each page with `header: true`.

The style is `Title`, `Heading1`, `Heading2`, `Heading3`, `Normal` (the default) or `ListBullet` (a bullet list);
`\t` and `\n` become a tab and a line break. The answer is `path` and `sha256`, the one `update` takes next, with
`sheets` (name and row count) or `paragraphs` (the count) and `tables` when there are any. Bold is a key of the JSON,
not a flag, since cli-base's vocabulary has none for it.

`history` lists `versions.list(path)`: each entry's `version` is the sha256 of what it replaced, and `available` says
whether the store still holds it. `restore <path> <version>` copies that version from the store and writes it with
`guardedFileWrite` (logged `direction: "restored"`), so a file there needs `--expected-fingerprint` and is kept first;
a version the store no longer has is `not_found`. The store is the one `write` and `read` hand over, so the edits, the
update and the restore keep into it and `history` reads it.

Besides the update's helpers, the CLI passes `read(act)`, its signed-in read path with the same target and version
store, and, when it has a trash, `restoreFromTrash(input)`: `restore` with no version calls it and answers what it
returns, so the CLI drops its own `restore` command. Without it the version is required. Every helper that acts
(`write`, `read`, `output`, `restoreFromTrash`) gets the running command as its last argument, so one set of helpers
asks each command's own permission key and records it in the send journal under its own name.

## Copy a document collection to another database

Use `previewDocumentTransfer` and `applyDocumentTransfer` from `@wirecat/cli-core/store` to retain
annotations when a provider changes databases. This persistence workflow lives in
`src/store/document-transfer/` and `src/store/sqlite/document-transfer/`; provider adapters bind the
explicit account, namespace, cached-content checks, profile lock and final checkpoint update.
It contains no provider client, CLI parser or model call.

```ts
const options = {
  source: "/var/tmp/example-original.db",
  destination: "/var/tmp/example-selected.db",
  collection: "example-documents:synthetic-owner",
}
const preview = await previewDocumentTransfer(options)
// Present counts, source_documents, missing_bindings and conflicts before applying.
const receipt = await applyDocumentTransfer({
  ...options,
  expected_fingerprint: preview.fingerprint,
})
```

The collection is its exact integration name, such as a provider/account namespace; duplicate names
are refused. Preview neither creates nor migrates either file. Source schema 2 through this build's
schema is supported without maintenance; upgrade a separate copy of an older source first. Applying
initializes or upgrades the explicitly selected destination. File aliases cannot make it the source.

The copy retains document and note revisions, tag/topic assignments and aliases, memory scope/status/
supersession, fact status/confirmation, authors and structured relationships in both directions.
Documents match by collection and external key, never title or row number. Different existing content,
conflicting topics/aliases and contradictory identity decisions refuse the transfer. Source provider
identities can reuse a verified destination person or create a separate person; equal display names
never merge people. Only minimal identity/current-association data and author handles are copied,
without bot credentials, private provider metadata or complete contact/account history.

Unmatched projects, tasks and other external endpoints appear in `missing_bindings`. The caller may
supply an explicit `bindings` object mapping source references to same-kind destination references.
Changes to these decisions or either relevant graph invalidate the fingerprint. Applying rechecks the
plan under the destination write lock and commits the complete bounded copy with its receipt in one
transaction. An interruption rolls back; repeating a completed unchanged copy returns its existing
mapping. The host publishes its checkpoint only after that receipt. Source changes detected during
the copy refuse checkpoint publication, retaining both databases. Stop other writers to the old store
while switching; this is a reviewed snapshot copy, not ongoing bidirectional synchronization.

Limits are 1,000 documents/annotation records, 10,000 relationships or tag assignments, 10,000 revisions
per record and a 16 MiB snapshot. Larger graphs refuse without truncation. Original files remain in
place. Structured references are remapped; literal references inside free text stay as written.
Embeddings and cached pictures are derived and must be indexed again explicitly. The host retains
its original refusal guard for store changes that have not completed this operation.

## Edit an Office file in place

A new workbook or Word document comes from `createXlsx` or `createDocx` (see [New Office files](#create-office-files)).
A provider with no document API, such as Yandex Disk, changes a workbook or a Word document by downloading the
file, editing it and uploading it whole. `@wirecat/cli-core/office` does the edit: `editXlsxCells` by cell address,
`editDocxParagraphs` by paragraph, each spliced into the original XML with every other zip entry copied byte for
byte, so fonts, styles, images, comments and tracked changes survive. It never rebuilds the file from text. What
it refuses and what collapses is in [Editing Office files](../office.md).
