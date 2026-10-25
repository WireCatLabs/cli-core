# Reviewed tag consolidation

`knowledge.previewTagConsolidation` and `knowledge.applyTagConsolidation` combine two plain tag
names into one effective label. The source rows remain stored with their original IDs and attribution.
Projects and topics are excluded. Similarity can suggest a pair; it never selects or applies a merge.

## Review and apply

Read a complete unfiltered `knowledge.vocabulary()` catalog. Select its source and survivor tag IDs,
then request a preview with those IDs and its `fingerprint` as `expectedVocabularyFingerprint`.
The preview reports assignments, aliases, automatic claims, links, overlapping targets and bounded
samples. Its `sourceMemberIds` and `survivorMemberIds` include previously consolidated records.

Applying requires the same IDs, both `expectedVocabularyFingerprint` and
`expectedPreviewFingerprint`, explicit `by: "owner"`, and a unique `idempotencyKey`. The key takes
1–128 ASCII identifier characters; use an opaque identifier, never source content. Agents propose
pairs for owner review. A host must derive owner authority from its existing actor boundary.
`coverage.applySupported` describes the store SDK capability. It does not mean a consumer has an
apply command or permits an MCP write; hosts must update their own commands and descriptions.

The store opens a short synchronous `BEGIN IMMEDIATE`, checks the complete current state, validates
the resulting redirect graph and commits the redirect and receipt together. No write lock is held
while a person reviews the preview. Changed vocabulary or dependency provenance refuses the entire
apply, even when the visible counts are unchanged. An aborted signal rolls back the transaction.
An exact authorized retry returns the original immutable receipt. Reusing its key with different
IDs or fingerprints refuses.

## Retained provenance and names

The physical source tag, taggings, automatic claims, aliases and both endpoints of polymorphic
links are retained. Applying does not overwrite competing authors, file origins, algorithm scores,
claim evidence or link evidence. Deduplicated display does not collapse those physical records.

`tag_redirects` stores current direct canonical mappings. On a later merge, every existing source
member points directly to the new survivor in the same transaction. The `resolved_tags` view uses
indexed joins rather than recursive graph traversal. Reads and search predicates include every
retained member; new assignments resolve names and aliases to the current canonical ID.

Catalogs expose canonical entries with deduplicated target usage. Original source names appear as
read-only aliases with `id: "tag:<retained-id>"` and `retained: true`. They cannot be removed as
ordinary aliases. Inherited real aliases retain their original positive IDs and can be removed
through the survivor's alias API. Historical text in saved queries, notes and action proposals is
not rewritten; name selection resolves it when the operation supports tags.

Explicit label removal withdraws the effective label across its members. An explicit manual or
automatic origin scope withdraws only that scope and preserves the other claim. Automatic rule
replacement withdraws the chat's previous automatic claims, then assigns the current matches.
Owner removal, target deletion and account purge must not resurrect retained assignments.

## Bounded state and text-free receipts

Each consolidation reads a complete plain-tag graph of at most 4,096 tags and 4,096 redirects.
The shared `createTagRedirectIndex` policy rejects invalid IDs, missing endpoints, cycles and
oversized graphs. Persisted mappings additionally must point directly to canonical rows.

Dependency review covers complete selected groups in `taggings`, `aliases`,
`canonical_auto_tag_claims` and both `links` endpoints. Defaults are 5,000 dependency rows and
1 MiB; callers can select at most 20,000 rows and 16 MiB. Budget exhaustion returns no partial
preview. Hashes cover every inspected provenance column, including private text omitted from samples.
The graph is independently bounded and included in the checked fingerprint and input byte budget.

`tag_consolidations` retains IDs, owner actor ID/type, timestamp, idempotency key, counts and hashes.
It stores no name, transcript, note, message, link-evidence or claim-text snapshot. Deleting source
content leaves no restorable copy in the receipt. A receipt records the historical reviewed choice;
a later redirect does not rewrite it or change an exact retry's answer.

## Document transfer boundary

Annotation transfer previews refuse a touched consolidated tag group in either source or destination.
The existing copy maps a tag by name and has one assignment per tag/target; flattening a group there
would lose independent authors or recreate duplicate labels. Both preview and apply therefore refuse
before changing either store. Ordinary unconsolidated tags remain transferable. Read-only source
stores from earlier supported schemas retain their existing snapshot path; an existing destination
needs current schema maintenance before its read-only preview.

Copying a consolidated group with its retained identities and provenance is a separate follow-up.
A merge receipt is not permission to silently merge unrelated labels in another destination store.

## Compatibility and activation gates

Store version 30 atomically renames `tags` to `canonical_tags` and `auto_tag_claims` to
`canonical_auto_tag_claims`, then adds redirects, receipts and the resolved view. Its
`minCompatible: 30` rejects earlier SDKs on new writable and read-only opens. No compatibility view
restores the old table names: that would allow old writers and readers to use different semantics.

An already-open old reader can finish its previous SQLite snapshot. It cannot upgrade that snapshot
to a writer after the structural change. After rollback, cached old tag statements refuse. Actual
Core 0.414.0 (store version 29) regression tests cover tag selection/addition/removal, automatic replacement, alias
changes and chat rekey; failed writes leave all fixture assignments and claims unchanged. Deliberate
old account purge remains permitted and removes the original target data and claims.

Every later manifest row must explicitly preserve or raise the activated compatibility minimum.
Manifest assembly refuses omitted, invalid or decreasing declarations, so a later additive migration
cannot accidentally re-admit an older SDK.

This compatibility change requires the coordinated breaking package policy and pinned consumer
rollout described in [architecture](ARCHITECTURE.md#adding-a-migration). The implementation must not
be merged or released before that gate is reviewed. A schema reservation alone does not authorize
activation, a package-major decision or weakening the existing release policy.

Before activation, refresh [coordination](COORDINATION.md#store-migrations) and verify that version
25 was not reassigned or overtaken. If another migration needs that next slot first, retire this
unused reservation, reserve a fresh slot and renumber the isolated implementation. Never append a
migration below a version an owner file may already have applied; the runner would skip it.
