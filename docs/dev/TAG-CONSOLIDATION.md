# Tag consolidation foundation

The store does not merge tags. `knowledge.previewTagConsolidation` inspects selected dependencies;
its `applySupported` remains false. The separate `createTagRedirectIndex` export from
`@wirecat/cli-core/store` validates a supplied complete tag graph without reading or changing a store.
There is no redirect table, merge command, migration or runtime reader change.

## Captured graph policy

`createTagRedirectIndex({ complete: true, tags, redirects })` accepts canonical positive numeric
IDs. Tags have `{ id, kind: "tag" }`; redirects have `{ sourceId, survivorId }`. Topics and projects
are excluded. Each array is bounded to 4,096 rows and each ID to a safe integer. Unknown fields,
duplicate IDs, missing endpoints, multiple edges from one source, cycles and chains longer than
16 hops fail before an index is returned. `complete: true` is a caller assertion, not proof that
a database query read everything: the future SQLite adapter must refuse truncated reads itself.

`resolve(id)` returns the requested ID, canonical ID, traversal path and numerically sorted
`memberIds`. Source records remain members; this policy does not delete, combine or choose between
their assignment authors, claim algorithms or link evidence. Input mutation and modification of a
returned array cannot change subsequent results. Row order cannot change resolution.

This shared policy gives prospective SQLite readers and writers the same definition of a label:

- Name and alias selection in `sqlite/tags.ts` and `sqlite/vocabulary.ts` resolves to the canonical ID.
- `tags.ts`, `knowledge.ts` and automatic chat tagging resolve before new writes. Retained rows keep
  their original IDs and attribution. A canonical assignment must not overwrite competing provenance.
- Tag listings and search predicates select every `memberIds` entry, then present the canonical name.
- A reviewed apply planner validates its proposed graph with this policy before writing. It must
  revalidate the current dependency fingerprint within the same SQLite write transaction.

Those integrations are requirements for a later slice, not behavior supplied by this helper. In
particular, passing this helper a graph does not make current store searches understand redirects.

## References that a future apply must cover

The implementation inventory at source `1effa17c` includes these concrete entry points:

| Paths under `src/store/` | Required integration |
| --- | --- |
| `sqlite/tags.ts`, `sqlite/vocabulary.ts`, `sqlite/knowledge.ts` | Names, aliases, vocabulary fingerprints, ID selection, assignment writes/removal/listing and account-path label links |
| `sqlite/chats.ts`, `sqlite/tags.ts` | Automatic claims and replacement; preserve claim reasons separately from owner assignments |
| `sqlite/meeting-hit-search.ts` | Selected label IDs in meeting search and cursor binding |
| `sqlite/catalog.ts`, `sqlite/imported-documents.ts` | Document selection by canonical names/aliases |
| `sqlite/lucene-fields.ts`, `sqlite/note-search.ts` | Direct name predicates for messages, mail, notes, documents, identities and account-path links |
| `sqlite/document-transfer/{snapshot,plan,apply}.ts` | Source graph capture, destination mapping, conflicts and assignment/alias provenance |
| `sqlite/accounts.ts`, `sqlite/chat-rekey.ts`, schema triggers | Purges/rekeys must still remove target-owned data rather than resurrecting it through retained labels |
| `sqlite/tag-consolidation.ts` | Complete dependency reads and stale-plan checks; the present four-table preview does not certify all serialized references |

`aliases`, both `links` endpoints and historical action subjects may retain original tag IDs.
Saved queries, note bodies and proposal JSON may retain names as text. Historical text is not
rewritten. Projects, task keys and main-topic selection stay outside tag consolidation.

## Compatibility blocks activation

`src/store/migrations.ts:migrate` compares the latest file row's `min_compatible` with the SDK's
latest migration number only while opening a writable connection. An additive migration with
`minCompatible: 1` lets older SDKs continue opening the file. `sqlite/read-compatibility.ts` does
the corresponding check for read-only opening. Neither check is a per-operation capability gate.
`sqlite/transaction.ts` does not recheck compatibility on an already-open handle. Document transfer
has its own source-file check in `store/document-transfer/index.ts`; it is not a general write gate.

Consequently, an additive redirect table cannot safely activate consolidation: old readers would
still show source names and old writers could assign retained source IDs. Raising `minCompatible`
rejects future old opens, but does not stop old connections that are already open. The migration
contract currently describes raising that minimum as a package-major change. No such change is
included here and no migration number is reserved.

`src/store/tag-redirect-compatibility.test.ts` demonstrates both failure modes with two connections
and a synthetic manifest: an additive minimum admits old opens; a raised minimum refuses those
opens but the old connection can still read source labels and commit writes through `writeBatch`.
These are deliberately isolated fixture tables, not a proposed production migration.

The smallest activation follow-up must specify and test a coordinated compatibility boundary:

1. Reserve a schema version in a separate coordination PR before implementing persistence.
2. Integrate canonical resolution into all paths above; retain original dependency rows rather
   than materializing lossy duplicate assignments. Test deletion, transfers and same-target overlap.
3. Choose a supported breaking manifest gate and upgrade affected consumers together. Prove old SDK
   opens refuse. Define an explicit quiescent activation procedure that closes old connections;
   opening checks alone cannot establish it. Do not claim a new per-operation gate retroactively
   protects older binaries that never call it. Persistent background consumers are part of this gate.
4. Test an already-open old SDK across activation. Until the compatibility boundary and connection
   lifecycle are enforced, keep apply unavailable. A graph-only release cannot unlock it.

## Provenance and receipts

A prospective redirect retains the source `tags` row, assignment rows, automatic claims, aliases
and polymorphic links. Effective reads group them by canonical ID but attribution remains attached
to its original record. Removal must define which original claims it withdraws; silently deleting
every contributor is not a valid consequence of deduplicated display.

A future immutable receipt stores selected IDs, actor ID/type, timestamp, idempotency key, counts
and bounded cryptographic hashes of the checked state. It must not retain transcript, note,
message, link-evidence or automatic-claim text snapshots. Target deletion must continue purging
the original content and derived search material. Receipts cannot restore deleted content.
The existing preview fingerprint is evidence of inspected state, not authorization or a complete
write plan. Exact retry may return a receipt only after matching the same authorized selection.

Use Core's short synchronous `BEGIN IMMEDIATE` transaction for compare-and-apply; no writer or
file lock is held while a user or agent reviews a preview. Stale state refuses the entire write.
