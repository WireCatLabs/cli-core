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
  strict schema keeps all of it. A round of changes is saved under the scope `<scope>:changes:<cursor>`, which names
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
  find is removed; a pass cut short removes nothing and goes on from its saved walk. A chosen folder that answers
  `not_found` is skipped as unavailable and its documents go; with a feed, the same root fails the rescan instead.
  On a path-addressed source a root moved on the provider answers `not_found` too, so its documents go until the
  folder is chosen again under its new path. A file kept by name only is read again only once it changes. The cost is one listing of every
  folder per sync, so such a CLI keeps its folders selected rather than the whole account.
- **A source that addresses files by path** reads the path from the file the sync passes: `metadata(id, known)` (the
  folder as the last pass held it, for a root or a folder that answered 404), `children(id, folder)`,
  `childrenPage(id, cursor, folder)`, `content(id, maxChars, file)` and `bytes(id, file)`. Its ids stay stable ids
  (Yandex Disk's `resource_id`), so a moved file keeps its notes and tags; a root it cannot find by id is the CLI's
  to resolve from its own settings.
- **Not resumable:** one call of a source's `children()` (without `childrenPage`), one page of `childrenPage`, or one
  `changes()`. A folder listed with `children()` is listed whole, so a source caps its own listing (drive at 10 000
  entries in one folder or one change feed).

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
`addCalendarCommands` and `addCrmCommands` are. `addDocumentCommands(program, options)` mounts them all;
one builder per group lets a CLI place its own groups between them (drive puts `transcripts` and `store` after
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
notion-cli and drive-cli predate it and keep their own wiring.

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
`syncFileMirror`, instead of `pushDocuments`: it copies bytes, never merges text, and reads the remote with one
listing per run instead of one read per file. The provider implements `FileTarget`:

```ts
interface FileTarget {
  identity(): Promise<string>
  list(root: string, signal?: AbortSignal): Promise<{ rootId: string; files: RemoteFile[]; complete: boolean } | undefined>
  download(path: string, into: string, signal?: AbortSignal): Promise<void>
  upload(path: string, from: string, expect: Expect, signal?: AbortSignal): Promise<RemoteFile>
  trash(path: string, expect: { sha256: string; md5?: string }, signal?: AbortSignal): Promise<void>
  ensureFolder(path: string, signal?: AbortSignal): Promise<void>
  revision?(signal?: AbortSignal): Promise<string>
}
type Expect = { absent: true } | { sha256: string; md5?: string }
```

`list` returns each file's path relative to `root`, its `id` (kept across a move and an overwrite), `size`, `sha256`
(the plain hash of the content), `md5` and `modifiedAt`, plus the root folder's own id and `complete`, false when a page was skipped or a cap was hit. The other calls take the
remote path, `root` joined with the relative path. `download` and `upload` stream a local file, so a file of any
size takes the same memory. Every write is conditional on what the listing saw: `upload` and `trash` refuse with a
`conflict` error when the remote file is not as `expect` says; a provider without an atomic check reads the file
just before the write. An editing command reuses the same call, `upload(path, file, { sha256: whatWasDownloaded })`.

1. Each path is compared three ways: the local file now, the remote file now and the last sync (`FileEntry` in the
   state). A change on one side is copied to the other. The same content on both sides is adopted without a
   transfer, so a first sync of two identical trees moves nothing. Different content on both sides, or a deletion
   on one side against a change on the other, is a conflict: never overwritten, reported with each side's time and
   size, and the run ends with a `mirror.partial` issue. `keep` settles conflicts on a later run: `local` and
   `remote` pick a side; `both` downloads the remote version beside the local one as
   `name (conflict YYYY-MM-DD <remote>).ext`, then sends both. The copy enters the state only once its upload
   returns, so a failed upload leaves it to send next time, never to delete.
2. A deletion crosses sides into a trash: the remote's (`trash`, with the expected hashes) or
   `<root>/.wirecat-trash/YYYY-MM-DD/`, which is hidden and so never synced. Up to 2 deletions always go through; a
   run that would delete more than 2 files and also more than 50, or more than a quarter of the mirror, stops before
   any write with `mirror.too-many-deletions` unless `allowDeletions` covers the count.
3. A remote file found at a new path with the same `id` is renamed locally. A local rename is a deletion and a new
   file.
4. A local file whose size and mtime match the state is not hashed again (`scanLocal`'s `known` lookup). A local
   write goes through a hidden temporary file and lands only if the file still has the hash the run read, or is
   still absent for a new file; a download whose content does not match the listing's `sha256` never lands. An
   upload that reads back with another hash is a conflict. A new file, a local rename and a local trash land with a
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
   retried within the run. A download whose copy into place was cut off may leave a partial file under its name:
   while that file has neither the remote's nor the last sync's content, its `pending` entry stays and the path is a
   conflict whatever `keep` says; moving the file away lets the next run download it. The state is saved at most
   once a second and at the end.
7. A file counts as deleted on a side only when the last sync saw it, the side's listing is complete, and the side's
   root is the same folder: the remote root has the id it had at the first sync; the local root exists, is a folder
   with the device and inode recorded at the first sync, and is not empty while the state has files (an unmounted
   drive reads as empty). A file missing from an incomplete listing is reported in `unknown` and nothing is deleted
   for it. When a root fails, the run does nothing, reports every file of the state in `unknown` and the root
   problem in `errors` (path `.`), even at a first sync. Either way the run is partial. A file the last sync did not
   see is never a deletion. Hidden remote files are skipped as local ones are.
8. A root that was replaced (the remote root has another id, or the local folder another device or inode) blocks
   the mirror until the owner confirms it is the right folder: `repin: true` (a CLI's `--repin`, named in the
   error) records the new identity and runs a first sync: identical files are adopted, one-sided files copied,
   different ones reported as conflicts whatever `keep` says, and nothing is deleted in that run. Only a mirror whose
   root was replaced is re-pinned: `syncFileMirrors` with `repin` leaves the state of every other mirror as it is. A
   root that is gone, or a local folder that is empty where the state had files, still blocks.
9. `dryRun` lists the remote and returns the `plan`; it writes nothing on either side and saves no state.

`versions` (`fileVersions(dir)`, with `dir` under the profile's state folder, one per mirror, never inside the
mirrored folder) keeps the content of every local file before the sync overwrites or deletes it (a pull, `keep:
"remote"`, a crossed deletion) in `<dir>/objects/<sha256>`, and appends each change to `<dir>/log.jsonl`: path,
event (`created`, `changed`, `deleted`, `renamed`), direction, old and new hash, size and time. An upload logs the
remote version it replaced as `old`. Retention is one rule, applied after each sync under its lock: a content stays
while a log event newer than 30 days names it, and the last content of a path whose newest event is a deletion stays
for good. A content no event names (a crash between keeping it and logging the change) stays 30 days after it was
last kept; one that vanishes while prune runs is skipped. Call `versions.prune()` only under the sync lock.
`versions.list(path)` lists a path's events with `available` (bytes still kept); `restoreFileVersion(root, path,
sha256, versions, lock)` puts one back under the same lock as a sync, keeping the current file first, and the next
sync sends it.

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
