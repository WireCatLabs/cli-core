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

## Push local files to a provider

`pushDocuments` mirrors a local folder one way into a provider's native documents. The provider implements
`DocumentTarget`: which local paths it takes (`kindOf`), find-or-create of folders by an origin key, `create`,
`prepare` and `findByOrigin`. It persists `PushState` through `PushStatePort`, holds its profile lock and passes
`assertHeld`, and wraps each write in `guard` with its permission checks and write journal.

1. Unchanged files are skipped by content hash with no remote call. `planPush` is the plan alone (`dryRun`).
2. A create saves a pending origin key first; the provider stores it on the remote file. After a crash, the next
   run finds the file with `findByOrigin` and updates it instead of creating a second one.
3. `prepare` reads the remote and compares it with the snapshot the last push recorded. It returns a conflict
   (unless `force`), `missing`, `unchanged` (nothing to write) or a `write` step; only `write` runs inside `guard`,
   so a conflict never reaches the write journal. The snapshot is the provider's own read-back after its write, so
   its own push never looks like an edit. One file is one provider write (or one all-or-nothing batch): a write cut
   in half would read back as an edit.
4. Nothing is deleted remotely. A file deleted locally is an orphan; a file deleted remotely is missing and is
   created again only with `force`.

For documents with structure, `markdownBlocks` (async; the parser loads on first use) parses Markdown into `Block`s (headings, paragraphs, bullet,
numbered and checklist items, code, quotes, tables, images, rules) with inline marks. The provider maps its own
document into the same blocks and writes only `diffBlocks(current, next)`, so unchanged paragraphs keep their
comments and formatting. `reconcileBlocks(recorded, current, local, lastLocal)` allows one remote change, a
checklist tick: a tick follows the side that changed it, judged against `lastLocal` (the file at the last push), so
a remote tick survives later pushes. Any other remote change is a conflict. The provider's snapshot therefore keeps
both the blocks it wrote and the local blocks it pushed. A field the provider
cannot read back must stay out of its blocks, or that block would differ on every push.

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
