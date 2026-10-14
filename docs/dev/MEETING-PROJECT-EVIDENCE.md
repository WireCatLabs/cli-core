# Project-word evidence interface

The SDK's `readMeetingProjectDiscovery` is implemented; the consumer interface below is the
contract for the next shared CLI/MCP adapters. It is not mounted in a released application yet.

## Commands and scope

`meetings projects evidence <project> [query...]` reads one bounded name page for an existing project,
resolved by its canonical name, key or explicit alias. `evidence` is an existing shared noun view;
it sits under the `projects` subresource because it reads project-name evidence in stored meeting
passages. The existing `meetings evidence <meeting-reference>` remains the whole-meeting evidence
view. These distinct views do not create membership.
`meeting_project_evidence` is the corresponding MCP tool. Both bind the selected account through
the host; neither accepts an account override.

The optional query uses the common query parser and fields: `meeting_id`, `identity_id`,
`person_id`, `tag_id`, `event_id`, `series_id` and `started_at`. IDs are positive safe integers;
each field occurs once and terms join with AND. IDs take exact values; time accepts a value or
range in UTC. OR, negation, duplicate fields and unsupported operators fail before a read.
`identity_id` is a participant observation constraint, never speaker attribution. The query cannot
apply a confirmed project-membership filter: finding unlinked candidate meetings is its purpose.

CLI options are the existing `--limit`, `--cursor` and `--max-read-bytes`. MCP uses `project`,
optional `query`, `limit`, `cursor` and `max_read_bytes`, rejecting unknown properties. Limit
defaults to 100 (maximum 1000); word reads default to 4 MiB (maximum 64 MiB). Vocabulary reads use
the SDK's separate 1 MiB budget and at most 32 names. Excess names or vocabulary size fail visibly.

## Answer

Both interfaces return an item envelope whose registered entity is `meeting_project_evidence`.
The aggregate item preserves one coherent discovery page:

- `account_id` as a string, original project `query`, canonical `project` with string ID/name/key,
  and matched `term` with kind and optional string alias ID;
- `hits` as standard `meeting_hit` entities with retained refs and excerpts;
- `association: "unconfirmed-word-evidence"`, `vocabulary_fingerprint` and all SDK limits in
  snake_case;
- `selection` containing the effective ID/date constraints, with dates frozen to absolute UTC
  ISO timestamps;
- `page` with limit, has_more and optional cursor, including continuation after an empty page;
- `coverage` with archive/index completeness explicitly unknown, current revisions, indexing
  state, name index/count/remaining names and possible duplicate refs between names.

The host adds standard run metadata. A `page.next` action repeats the project, frozen query,
cursor, limit and word-read budget. CLI and MCP map the same semantic arguments to their transport
spelling. A relative date is resolved once per request and serialized as absolute bounds in the
next query; it cannot silently move the cursor's selection on a later day.

The reader does not maintain indexes. Descriptions must state this, and pending indexing remains
in coverage. An adopting host may explicitly use shared index maintenance through its search port,
but must retain that local effect and pending coverage. Unknown completeness is never a negative
claim about a project or the full archive. Repeated refs are the same evidence.

## Modules and validation

Domain files own query parsing, the account-bound reader contract and schema/answer mapping.
The existing service owns vocabulary resolution, bounded reads and cursor binding. Separate small
CLI/MCP modules translate their inputs and call the same domain adapter. Zoom binds its selected
account, store ports, deadline and close-before-output lifetime; it contains no alias policy or SQL.

Synthetic tests must cover equivalent CLI/MCP answers, unknown arguments, scope/date constraints,
relative-date continuation, empty-name continuation, pending indexes, cancellation and the complete
registered entity. The existing SDK SQLite and second-provider cases remain the evidence for
alias resolution and source paging. Adoption also requires reviewing the newer Core read envelopes
and errors, then registry-pinned producer/consumer releases and immutable documentation sources.
