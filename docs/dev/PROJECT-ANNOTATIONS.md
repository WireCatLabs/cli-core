# Project annotation manifests

`decodeProjectAnnotations` and `projectAnnotationsFingerprint` from `@wirecat/cli-core/store` validate
the selected annotation graph independently of a provider, CLI, model or database. They perform no
store or filesystem access. They are not project export/restore commands.

The format is `wirecat.project-annotations`, version 1. It contains a project descriptor, aliases,
facts, direct links and explicit external references. Coverage must say that those three selected
facets are complete and that memories, tasks, labels and findings are omitted. An empty omitted
facet must never be interpreted as an empty source facet or permission to delete destination data.
The project descriptor identifies an existing baseline project; it is not a complete project row.

Each external text reference carries a SHA-256 content hash; external people, bots and other
non-text references carry `null`. No external document, note, message or transcript body belongs in
the manifest. A link to a source or a person does not make that record project-owned. External
dependencies must be used, unique and distinct from the project's owned fact references.

The decoder refuses unknown fields and versions, incomplete selected facets, duplicate identities,
normalized alias collisions, missing dependencies, unrelated links, invalid fact lifecycles and
decision replacement cycles. Input is capped at 4 MiB before JSON decoding, 1,000 records across
the selected arrays, and bounded individual fields. Validation errors identify the invalid field or
graph constraint without including source text. The fingerprint includes lifecycle, provenance and
external hashes; JSON property order and record-array ordering do not change it.

`planProjectAnnotations` takes validated manifest JSON, explicit source-to-destination bindings and
an adapter's complete target snapshot. It checks the project binding, dependency kinds, source text
hashes, missing references, duplicate bindings and whether the target already has annotations. A bot
cannot become a person through binding, and two actors cannot silently become one. Provider reference
kinds must match; a transcript cue cannot bind to a whole meeting. The plan's fingerprint includes the
manifest, bindings and target revision. No SQL, mutation, name-based matching or identity creation occurs.

The target snapshot contains an explicit project reference, annotation count, revision SHA-256 and
bounded external references/hashes. It must come from a consistent store adapter, not an agent's
description of what the destination probably contains. A ready pure plan is not permission to write.

## Read-only SQLite snapshots

`snapshotProjectAnnotations({ source, project, env?, maxReadBytes? })` opens an explicit existing store
path through the native read-only SQLite handle and selects an explicit `project:<id>`. It reads the
project and dependencies in one consistent transaction, then closes the handle. It performs no
migration, maintenance, source fetching, model call or output-file publication. A missing store is
an error, never a request to create one. The schema must be exactly the SDK's current schema.

The result contains `snapshot`, `fingerprint`, `read_bytes` and `records`. The latter two are
conservative budget charges for logical rows and selected input bytes, including dependency probes
and per-row overhead; they do not measure physical SQLite I/O. The input budget defaults to 4 MiB
and accepts 1–4194304 bytes. Reads preflight text sizes before hydrating text, and stop at 1,000
charged records. The resulting JSON must also fit the manifest's independent limits.

This reader produces version 2, decoded by `decodeProjectAnnotationSnapshot` and hashed by
`projectAnnotationSnapshotFingerprint`. It preserves the project description, status, owner and
update time, and each alias's name, source, display flag and timestamps. Version 1 remains unchanged;
its planner does not accept version-2 snapshots. Owner-scoped, non-deleted projects are supported.
Account-scoped projects or aliases, deleted facts, unknown fact metadata, and unknown link metadata
are refused. Known link provenance is preserved along with origin, author, confirmation, evidence,
roles, anchors, unresolved target text and timestamps.

Facts owned by the selected project and generic links touching that project or its facts are selected
completely. References do not recursively make other projects or sources owned. The coverage map
explicitly omits internal notes, specialized meeting memberships, tasks, memories, labels and findings.
This is a selected annotation snapshot, not a complete project backup or a safe reset prerequisite.

External source hashes use SHA-256 over JSON `["wirecat.project-source", 1, kind, content]`.
Store row IDs and revision counters are excluded from `content`:

| Source | Content included |
| --- | --- |
| Document or internal note | Title and body |
| Message | Text, sent time, sender label, sender chat external ID and sender identity's provider/external ID |
| Mail | Subject, plain-text body, sent time, sender address and sender name |
| Meeting | Title, description, location, start/end time, duration and timezone; no join URL |
| Transcript cue | Position, start/end offsets, speaker name and text |
| Whole transcript | Format, language and source, followed by all cues in position order |

Text sources must still exist and be available; deleted meetings invalidate dependent transcript and
cue reads. Historical, non-deleted transcript versions remain valid references. People, bots,
organizations, other projects, chats, identities and account/folder references carry `null` hashes and
need explicit bindings. External facts, memories and tasks are refused by this reader. Hashes bind
specific source content, not semantic equivalence or inferred identity.

`planProjectAnnotationSnapshot(json, target, bindings)` supplies pure binding validation for version 2.
It requires a separate binding for every external dependency, including a project owner referenced
only by the descriptor. Its fingerprint includes all version-2 metadata, manifest hashes, bindings
and the adapter-supplied target revision. Alias provenance and timestamp changes invalidate the plan.
Source/target inputs remain unchanged and proposed facts remain proposed. Reference kinds, changed
source hashes, missing/duplicate bindings and populated selected annotation targets are checked by
the same policy as version 1. It does not open a database, resolve names, check the destination's
global alias namespace or authorize writes. The caller must supply a complete, consistent target
snapshot; a fabricated snapshot establishes no database preconditions.

## Database preview

`previewProjectAnnotationSnapshot({ snapshot, target, project, bindings, env?, maxReadBytes? })`
decodes version-2 JSON, checks explicit binding syntax before opening the target, and reads an existing
destination through a native read-only handle. The project reference is explicit. One consistent
transaction covers the selected annotation snapshot, bound external content hashes and project
namespace. No source is fetched and no destination is created or maintained.

The result includes the pure `plan`, `descriptor_conflicts`, `namespace_conflicts`, `ready`,
`fingerprint`, `read_bytes` and `records`. The baseline project's key and name must match exactly.
Other projects' normalized names, keys and owner-scoped aliases cannot collide with the selected
names; deleted/account-scoped project keys still reserve their unique key. Namespace conflicts name
project references without copying their names into the result. A ready result requires no pure-plan,
descriptor or namespace conflict. Selected aliases, facts or generic links already on the destination
cause a populated-target conflict; omitted facets are never permission to overwrite other data.

The fingerprint binds the manifest and bindings to the actual target snapshot, bound source hashes
and bounded namespace rows. Even an unrelated namespace change can invalidate it conservatively.
Metadata probes precede source hydration. The existing snapshot limits also charge namespace reads,
so a store whose project catalog exceeds the budget is refused rather than partially checked.
Deleted, unavailable or unsupported dependencies may refuse the read instead of producing a ready
preview. The public pure planner remains useful to other adapters; a ready pure plan is not the
same as a successful database preview.

## Atomic selected-annotation restore

The optional `store.projectAnnotations` port uses the store's existing connection. Its `preview`
takes `{ snapshot, project, bindings, maxReadBytes? }`; `restore` additionally requires the exact
`fingerprint` returned by preview. The port opens no other store and performs no migration. A host
must authorize restore before calling it. A read-only connection remains unable to restore.

Restore starts a standard synchronous write transaction, rechecks the entire database preview under
`BEGIN IMMEDIATE`, and refuses a changed fingerprint, conflicting namespace/descriptor, stale source
hash or populated selected target. There is no `await` in that transaction. Failure rolls back the
descriptor update, aliases, facts, links and derived work together. A retry into a populated selected
target refuses rather than creating duplicates. No durable resume receipt or worker lease is written.

The existing target's key/name remain unchanged and must match the source baseline. Selected project
description, type, scope, organization, owner, status and historical dates are restored. Fact subjects,
replacement decisions and generic link endpoints use explicit mappings; facts may reference later
owned facts. Status, model, author, confirmation provenance, alias provenance and timestamps survive.
An accepted historical fact remains accepted; a proposed one stays proposed. This is not a new agent
confirmation. Shared people, organizations, documents, other projects and their annotations are not
recreated or edited. Target task counts and omitted facets are untouched.

The receipt returns the project, preview fingerprint, reference mappings and selected record counts.
It is an operation result, not proof of a full project backup. Host policy remains necessary: neither
a valid snapshot nor a matching fingerprint authorizes an agent to restore accepted records. No
CLI/MCP mutation host, live-project reset or store migration is included in this SDK port.
