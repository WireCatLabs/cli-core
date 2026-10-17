# Bounded stored context readers

For SDK hosts reading explicitly selected local messages, mail or imported documents. These readers
are a foundation for cross-source meeting context; meeting preparation and its CLI/MCP arguments
do not yet query these sources. Keep their existing `unqueried` coverage unchanged.

## Bind authorized sources

Core's optional `MessageStore.contextEvidence` is the native read port. Wrap it with
`createContextEvidenceReader` from `@wirecat/cli-core/services` and the host's authorized selection.
Account discovery is not authorization. Capture the selection from trusted profile/folder binding,
not arbitrary account IDs supplied by a request.

Each source includes its resource kind, stored account ID, provider and external account key.
The factory snapshots up to 32 authorized sources without I/O. Empty or missing authority fails;
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
    before: Date.parse("2026-09-30T23:59:59.999Z"),
    limit: 10,
    maxReadBytes: 65536,
  })
}
```

This factory borrows an already-open port. It does not open or close a store, resolve profiles,
synchronize providers, fill indexes, load models or write records. Store opening has its own
migration/backfill behavior; this API does not make opening the store a read-only operation.
The host owns resource lifetime and closes resources before publishing an answer.

## Read bounds and evidence

Queries contain 1–16 literal Unicode words within 2,048 UTF-8 bytes. All words must match the
existing word index; there are no stems, wildcard expansion, semantic search or query predicates.
Words such as `OR` are literal words. Query text cannot change account or inclusive timestamp bounds.
Each page returns at most 20 records (default 10), newest first by time and internal row ID.

The read-text budget defaults to 64 KiB and is capped at 1 MiB. Before any record is hydrated,
SQLite probes the UTF-8 sizes of its body, title, URL and locator metadata, including the one-row
lookahead. An oversized page fails with `validation_error`, reason `context.read-budget`; it does
not hydrate the records then truncate them. `readBytes` reports those bytes, including discarded
lookahead. This is not a limit on serialized JSON, database scanning, SQL execution time or total
work across several pages/sources. The later preparation assembler must enforce aggregate and
final output budgets separately.

Each item retains its canonical message/document reference, provider/account identity, text, title,
available source URL, timestamp, update time and document revision. Imported document time prefers
the stored remote modification time, including existing Drive front-matter provenance; a local
update fallback is explicitly `stored-update`. Internal owner notes are excluded: the existing
[preparation notes reader](MEETING-PREPARATION.md) applies their own association rules.

## Coverage, continuation and consistency

`available` describes the selected account identity, not archive completeness. Index coverage is
`ready`, `pending`, `missing` or `unknown`; readiness concerns local words in the selected window.
Queued document/mail rows and unnormalized messages are excluded from matches until an explicit
indexing workflow makes them current. Empty pages and exhausted pagination still have unknown
archive completeness. Undated mail/messages are reported separately rather than assigned a date.

Use `next` as the next request's `cursor`, keeping the same source, query and dates. Scope changes
are refused before source access. A cursor binds scope, not a historical snapshot: every native
page has its own read transaction, so later pages may reflect intervening edits. Do not infer that
finishing pages revalidated earlier evidence. Cancellation is checked around synchronous reads and
releases the read transaction before returning.

Existing hosts may omit the optional port. This slice adds no preparation assembler, commands,
MCP tools, automatic identity/project links or provider authentication. Another meeting provider
uses the same shared reader; only its composition root selects authorized source bindings.
