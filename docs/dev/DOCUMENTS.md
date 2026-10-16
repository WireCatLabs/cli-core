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
