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

SQLite snapshot reading, explicit destination binding, preview and atomic apply remain separate
work. A future snapshot adapter must read each selected facet completely within budgets and refuse
unsupported metadata rather than silently dropping it. Portable source hash rules and the
destination's preconditions must be defined before implementing apply. A host must enforce owner
policy; neither a valid manifest nor a matching fingerprint authorizes accepting an agent's proposals.
No live-project reset or migration is part of these helpers.
