# Bounded stored context readers

For SDK hosts reading explicitly selected local messages, mail or imported documents. These readers
can feed the optional [meeting communications assembler](MEETING-COMMUNICATIONS.md). A host
must explicitly bind authorized selections; omitted communications retain existing preparation
output and coverage. Production provider bindings are separate from this SDK capability.

## Bind authorized sources

Core's optional `MessageStore.contextEvidence` is the native read port. Wrap it with
`createContextEvidenceReader` from `@wirecat/cli-core/services` and the host's authorized selection.
Account discovery is not authorization. Capture the selection from trusted profile/folder binding,
not arbitrary account IDs supplied by a request.

Only whole message/mail accounts and whole imported folders are supported in this slice.
Chat, mailbox, thread, document-list or other selectors are refused by name instead of ignored.
Requests, sources, cursors and allowance options reject unknown fields.

Each source includes its resource kind, stored account ID, provider and external account key.
The factory snapshots up to eight authorized sources without I/O. Empty or missing authority fails;
the request chooses one exact authorized source. The native query independently checks all account
fields, so a reused ID does not grant access to its replacement. Document folders use their stored
`folder` account identity; never classify all imported files as an authorized Drive profile.

```ts
import { createContextEvidenceReader } from "@wirecat/cli-core/services"
import type { MessageStore, StoredAccount } from "@wirecat/cli-core/store"

async function readSelectedMessages(store: MessageStore, authorized: StoredAccount) {
  if (!store.contextEvidence) throw new Error("Host lacks bounded context reads")
  const source = {
    kind: "message" as const,
    accountId: authorized.id,
    provider: authorized.provider,
    account: authorized.account,
  }
  const reader = createContextEvidenceReader(store.contextEvidence, [source])
  return reader.read({
    source,
    query: "launch checklist",
    after: Date.parse("2026-09-01T00:00:00Z"),
    before: Date.parse("2026-10-01T00:00:00Z"),
    limit: 10,
    maxReadBytes: 65536,
  })
}
```

This factory borrows an already-open port. It does not open or close a store, resolve profiles,
synchronize providers, fill indexes, load models or write records. Normal store opening has migration/backfill behavior. A host requiring no maintenance must use
[read-only opening](STORE-OPENING.md); this reader factory does not change an already-open connection.
The host owns resource lifetime and closes resources before publishing an answer.

## Read bounds and evidence

Queries contain 1–16 literal Unicode words within 2,048 UTF-8 bytes. All words must match the
existing word index; there are no stems, wildcard expansion, semantic search or query predicates.
Words such as `OR` are literal words. Query text cannot change account or half-open `[after,before)` timestamp bounds. An explicit window spans at most 90 days.
Each page returns at most 20 records (default 10), newest first by time and internal row ID.

The read-text budget defaults to 64 KiB and is capped at 256 KiB. Before any record is hydrated,
SQLite probes the UTF-8 sizes of its body, title, URL and locator metadata, including the one-row
lookahead. An oversized page fails with `validation_error`, reason `context.read-budget`; it does
not hydrate the records then truncate them. `readBytes` reports those bytes, including discarded
lookahead. This is not a limit on serialized JSON, database scanning or SQL execution time.
The native raw port bounds one page; the factory additionally enforces the per-invocation ledger
below. The later preparation assembler must enforce final output budgets and preserve source
coverage separately.

Each item retains its canonical message/document reference, provider/account identity, text, title,
available source URL, timestamp, update time and document revision. Imported document time prefers
the stored remote modification time, including existing Drive front-matter provenance; a local
update fallback is explicitly `stored-update`. Internal owner notes are excluded: the existing
[preparation notes reader](MEETING-PREPARATION.md) applies their own association rules.

## One invocation's read allowance

Create a fresh scoped reader for each preparation invocation, retaining the host's trusted allowed
snapshot. Do not reuse its allowance across a long-lived MCP server's requests. Configure optional
`maxTotalReadBytes` (default 512 KiB, maximum 4 MiB) and `maxReads` (default 16, maximum 24) in the
factory's third argument. The request's per-call ceiling is clamped to remaining free capacity.
Reservations happen before dispatch, including concurrent calls. Valid successful pages charge
reported actual bytes and release unused capacity. Failed, cancelled or invalid reads charge the
full reservation; a retry cannot borrow those bytes. Empty pages still consume a read slot.
`usage()` returns independent snapshots of dispatched reads, charged/reserved bytes and free capacity.

The wrapper independently validates returned scope, references, dates, counts and text charges.
Foreign, malformed or oversized adapter answers are `invalid_response`, never silently truncated.
Native source queries retain their own scope/bounds validation before I/O; the wrapper does not
make arbitrary third-party backend work safe if that backend violates its read contract.

## Coverage, continuation and consistency

`available` describes the selected account identity, not archive completeness. Index coverage is
`ready`, `pending`, `missing` or `unknown`; readiness concerns local words in the selected window.
Queued document/mail rows and unnormalized messages are excluded from matches until an explicit
indexing workflow makes them current. Empty pages and exhausted pagination still have unknown
archive completeness. Undated mail/messages are reported separately rather than assigned a date.

Use `next` as the next request's `cursor`, keeping the same source, query and dates. Scope changes
are refused before source access; the scope hash also carries the reader protocol version. A cursor binds scope, not a historical snapshot: every native
page has its own read transaction, so later pages may reflect intervening edits. Do not infer that
finishing pages revalidated earlier evidence. Cancellation is checked around synchronous reads and
releases the read transaction before returning.

Existing hosts may omit the optional port. This slice adds no preparation assembler, commands,
MCP tools, automatic identity/project links or provider authentication. Another meeting provider
uses the same shared reader; only its composition root selects authorized source bindings.
