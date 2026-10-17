# Selected communications in meeting preparation

The preparation SDK can include cited local message, mail and imported document excerpts through
an optional `communications` port. Hosts without the port retain their existing answers and reject
explicit communications requests before their upcoming-provider lookup. This is a Core SDK and
shared-adapter capability; a provider application must bind it and adopt the released package.

## Bind trusted selections

```ts
const preparation = createMeetingPreparationService(scope, accountId, {
  meetings: store.meetings,
  upcoming,
  communications: {
    reader: store.contextEvidence,
    selections: [{ id: "project-chat", source: authorizedMessageAccount }],
  },
})
```

Verify the optional reader exists before binding. Each source is the complete stored
`{ kind, accountId, provider, account }` identity; the host obtains it from trusted configuration.
Selections authorize whole accounts/imported folders, not individual chats. The example ID is a
host label, not a project relationship or a transferable token. Never derive grants from request
IDs or discovered accounts. Bind one to eight unique IDs and source identities. The service copies
them and binds the reader at construction; later host mutations do not expand a running server.

The port borrows an already-open store. Use [read-only opening](STORE-OPENING.md)
(`openStore({ readOnly: true })`) and a host-owned lifecycle; normal opening performs maintenance. The service itself performs no
provider communication reads, indexing, models, associations or writes. Existing upcoming lookup
still uses the meeting provider. Close host-owned resources before rendering an answer.

## Request and continuation

```ts
await preparation.prepare(seriesId, {
  after, until, historyAfter,
  communications: {
    sources: [{ id: "project-chat" }],
    query: "launch checklist",
    after: communicationStart,
    before: after,
  },
})
```

All selected IDs, query words, windows and cursors are checked before meeting-account/upcoming
or source reads. Unknown fields and unsupported scope selectors fail by name. Empty selections
are errors; an omitted section performs no communications reads. Windows are half-open, nonempty,
at most ninety days, and end no later than preparation start. The default is fourteen days before
that start, clipped at epoch zero. Query text contains one to sixteen literal Unicode words within
2 KiB; `OR` is a word, not an operator. Titles/aliases can supply query words but never grant access.

Sources may include their returned opaque `cursor`. It is bound to the exact stored identity,
query and window; dates must stay fixed when resuming. A changed selection/query/window fails.
Sources are processed in captured host order, independently of request order. Continuations are
live per-page snapshots, not a historical snapshot of mutable content.

Each source reads one page of at most ten records with a 64 KiB ceiling, additionally constrained
by `maxReadBytes`. Each invocation has the reader's default 512 KiB/16-dispatch aggregate allowance;
failed dispatched reads consume their reservation. `read_usage` records aggregate charges, while
per-source `read_bytes` is null when no trustworthy successful charge was returned.

## Evidence, coverage and output

The assembler deduplicates canonical references within each source, preserves native rank, and
round-robins up to twenty excerpts across sources. Equal text across accounts is retained. Excerpts
use the shared word-centered helper with literal folded Unicode matching, at most 300 characters
and 1 KiB, and retain reference, title/URL, provider/account, timestamp basis, update and revision.
`text_truncated` identifies an excerpt whose content was cut; whitespace flattening alone does not
mark it truncated. A citation can be inspected separately;
the excerpt is not accepted fact or meeting-cue evidence.

`communications.coverage.sources` retains every selected identity and separates searched/unavailable/
read-limited state, index state, pagination, undated records, output limitation and restart.
Missing/pending/unknown indexes are reported without repair. Source failure or incomplete index
sets `meta.complete=false` and standard source issues; ordinary pagination alone does not. Archive
completeness remains unknown. Foreign/invalid adapter responses and cancellation fail the request.

Coverage is reserved before filling existing meeting sections. Communication excerpts yield space
first under the shared final-item budget, including MCP visible-control escaping. Discarded rows
retain their selected-source coverage and set `restart_required`; do not advance the cursor past
discarded rows. Restart or narrow that source, or increase the output allowance. Unfit mandatory
coverage is a budget error. Existing meeting section priorities remain intact.

With communications selected, `other-person-nonmeeting-context` and
`other-project-nonmeeting-context` identify the remaining unqueried context. Notes/knowledge say
`other_sources: "see-communications"`; this does not imply that unrelated accounts were searched.
Without communications, existing fields, references and fingerprints remain unchanged.

## Shared CLI and MCP

Given `communications: true` by a host that connects a messages source, the shared CLI builder
accepts repeatable `--context-source ID` or `--context-source ID=cursor`, `--context-query`,
`--context-since-time` and `--context-before-time`; without it, `meetings prepare` has none of the four.
Time flags require zoned ISO timestamps. MCP `meeting_prepare` accepts optional `communications` with the same `sources`/`query`
and ISO `after`/`before`. It refuses unknown nested fields in its handler as well as its schema.
Communication scope/query/window/read-usage metadata lives under `communications.coverage`,
which the standard projection helper retains even when selecting only `communications.items.ref`.
No account ID, provider, file path or credential is a public selection argument. The registered
entity and common envelope cover both adapters; projection does not reduce source read costs.
