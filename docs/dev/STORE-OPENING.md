# Opening a store for reads

`openStore({ readOnly: true })` opens an existing compatible database through a native read-only
SQLite connection under Node and Bun. It performs no store creation, migration, folded-name fill,
normalization backfill, stemming maintenance or log pruning. Ordinary `openStore` retains those
maintenance responsibilities; reading through an ordinary connection is not a no-maintenance open.

```ts
import { openStore } from "@wirecat/cli-core/store"

const store = await openStore({ path: authorizedStorePath, readOnly: true })
try {
  // Bind only the read ports needed by this invocation.
  const account = await store.meetings.account(selectedAccountId)
} finally {
  await store.close()
}
```

Resolve the authorized store/account/source configuration before opening. A file path is not a
source grant. The option is a trusted host/SDK setting, not a model-supplied preparation argument.
It must be a boolean. The API retains the normal store interface for compatibility; write methods
are still present in the type, but SQLite refuses them. Bind narrow read capabilities to services.
Some other store operations intentionally update derived state; do not use them as substitutes for
the explicitly bounded, no-maintenance context readers.

## Compatibility and refusal

| File state | Read-only opening |
| --- | --- |
| Missing file or parent | `not_found`; neither is created |
| Missing/empty/invalid schema history | `configuration_error`; no initialization or repair |
| Schema older than this package | `configuration_error`; explicit maintenance is needed first |
| Current schema | Open without maintenance |
| Newer additive schema whose `min_compatible` permits this package | Open without recording a migration |
| Newer incompatible schema | `configuration_error`; upgrade the tool |

The read-only path never falls back to a writable connection. Schema history is inspected without
creating the history table or entering a write transaction. A compatible schema does not prove
derived indexes are populated: bounded readers retain missing/pending/unknown coverage rather than
filling them. The runtime's existing in-memory SQLite capability probe still runs once per process;
it does not inspect or index source records.

The connection sets its local busy timeout, foreign-key enforcement and `query_only`; it does not
set a journal mode. Native read-only flags remain effective if a caller disables `query_only`.
Normal WAL coordination may use SQLite sidecar files; this is not an immutable-file snapshot.
Do not use SQLite's `immutable` mode to ignore a live writer's WAL. Read transactions retain their
existing per-page consistency, not a snapshot across remote calls or later requests.

The opener closes connections on pragma, compatibility, initialization or store-construction
failure. The successful caller owns `close()`. Opening does not authenticate a provider or grant
access to all accounts; services must independently enforce their captured source selections.

## Implementation boundaries

`sqlite/open.ts` owns native connection flags, pragmas and ORM construction. `sqlite/open-store.ts`
owns filesystem preflight and maintenance policy. `sqlite/read-compatibility.ts` inspects the existing
schema contract; `store.ts` wires lazy capabilities over the opened context. Both normal and read-only
paths use the same store adapters, with no provider-specific database logic.
