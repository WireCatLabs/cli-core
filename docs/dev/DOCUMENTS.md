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
2. Bind `documentIngestion` to the public store. Supply the provider/account collection name,
   external-ID mapping, catalog metadata and content front matter. The optional `observed` callback
   registers provider identities/roles. Identity mapping remains the provider's responsibility.
   The external id of a source file is `<id>.md` (``externalId: (id) => `${id}.md` ``), in the catalog
   entry, its parents and the saved note alike: the catalog commands strip `.md` to show the source's id.
   An account has no ceiling on its entries; one catalog write takes at most 200 and one list page
   at most 1000, and a save or a removal reads only its own document.
3. Supply `SourceStatePort` for validated account-specific checkpoints, discovery walks and
   snapshots. Existing Drive v1 checkpoints remain compatible; no database migration is required.
4. Acquire the account/profile lock before `syncDocuments` and release it in `finally`. Supply
   `assertHeld`, provider-safe `errorOf`, classification/retry rules and positive bounds. The shared
   engine retains failed work, advances the cursor only after the batch completes and retires
   sources leaving the selected tree. The state account must match the selected principal.
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
