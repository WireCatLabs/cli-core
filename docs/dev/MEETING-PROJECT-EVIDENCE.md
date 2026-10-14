# Project-word evidence interface

The SDK's `readMeetingProjectDiscovery` and shared CLI/MCP adapters implement this interface.
Hosts opt into the exports below; it is not mounted in a released application yet.

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

The host adds standard run metadata before returning a successful MCP response; the tool's
`outputSchema` declares the complete registered item envelope, including that metadata, or the
standard error object. Both branches stay strict because some MCP clients validate structured
error content as well as successful answers.
A `page.next` action repeats the project, frozen query,
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

| Export | Entry point | Responsibility |
|---|---|---|
| `MeetingProjectDiscoveryReader` | `/meetings` | Callback that omits account selection from caller input |
| `prepareMeetingProjectEvidence` | `/meetings` | Validate bounded input and freeze query/date constraints |
| `readMeetingProjectEvidence` | `/meetings` | Coordinate the injected reader and common answer mapping |
| `meetingProjectEvidence` | `/meetings` | Runtime schema, registered as `meeting_project_evidence` |
| `addMeetingProjectEvidenceCommand` | `/meetings/cli` | Mount `meetings projects evidence` under an existing meetings group |
| `meetingProjectEvidenceTool`, `callMeetingProjectEvidenceTool` | `/meetings/mcp` | Discover and invoke the equivalent strict MCP tool |

The host fixes the account in the callback passed to either transport:

```ts
const read: MeetingProjectDiscoveryReader = (project, options) =>
  readMeetingProjectDiscovery(ports, project, { ...options, accountId: selectedAccountId })
```

The account comes after caller options deliberately. The host owns permission checks, opening and
closing ports and final serialization limits. Tool discovery needs no connection. Both adapters
return an item envelope without `meta`, which the host supplies. The shared modules do not mount
themselves, open databases, maintain indexes or import a provider.

Synthetic tests cover equivalent CLI/MCP answers, unknown arguments, scope/date constraints,
relative-date continuation, empty-name continuation, pending indexes, cancellation and the complete
registered entity. The existing SDK SQLite and second-provider cases remain the evidence for
alias resolution and source paging. Adoption also requires reviewing the newer Core read envelopes
and errors, then registry-pinned producer/consumer releases and immutable documentation sources.
