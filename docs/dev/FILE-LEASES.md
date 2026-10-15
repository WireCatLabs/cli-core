# Native archive writer leases

Use `WriterLeaseStore` when a native archive writer needs exclusive ownership of shared
publication paths. The port and its native adapter are exported by `@wirecat/cli-core/files`.
Core owns marker parsing, process status, recovery and release; a provider host owns its layout,
credentials, transport policy and how contention is reported to a caller.

```ts
import { nativeWriterLeaseStore } from "@wirecat/cli-core/files"

const leases = nativeWriterLeaseStore({ markerDirectory: ".shared-archive-writers" })

async function archive(destination: string, write: () => Promise<void>, signal?: AbortSignal) {
  const ownership = await leases.acquire(destination, { signal })
  if (ownership.status !== "acquired") return ownership
  try {
    await write()
    return { status: "completed" as const }
  } finally {
    await ownership.lease.release()
  }
}
```

Constructing the adapter performs no I/O. The destination must already exist. Acquisition resolves
its physical root, creates a unique version 1 PID/host/nonce marker, checks competing markers and
returns `acquired`, `busy` with inspected owners, or `legacy` when the optional legacy marker exists.
It refuses to grant ownership if its own marker disappeared or became unrecognized before confirmation.
There is no waiting, retry or silent successful deferral. An interactive host can map `busy` to its
existing error; a scheduled host may deliberately report deferral as a distinct outcome.

All writers targeting the same publication paths must use the same marker layout and physical
root. A different account must not select a different lock namespace. Different marker directories
do not exclude each other: layout is a shared host decision, not an isolation guarantee between
uncoordinated applications. A root alias resolves to the same marker directory.

## Inspection and recovery

`inspect(destination, { signal })` and `recover(destination, { signal })` perform no writes.
Inspection returns sorted `active`, `stale`, `foreign` or `unrecognized` records. Only ESRCH from
the local process probe means dead; permission errors and reused live PIDs remain active. Foreign
hosts and malformed/oversized/symlinked owner files remain intact. Owner reads use the existing
ordinary-file validator and are capped at 4096 bytes, including a bounded growth check.

`recover(destination, { apply: true, signal })` rechecks each recognized dead local marker before
removing it. Acquisition applies that same recovery before competing. The current marker format
and unique nonce names match existing native archive consumers; legacy marker names are supplied
explicitly and are refused rather than deleted.

The acquired lease owns its release operation. Call it in `finally`, without the cancelled acquisition
signal. Concurrent/repeated successful releases share completion; a failed release can be retried.
Release refuses an unrecognized or changed owner record instead of deleting another record. Failed
or cancelled acquisition cleans its newly created marker; an empty marker directory can be removed,
but competing records and unrelated files are retained.

This is cooperative PID/nonce ownership, not a kernel lock or a distributed lease. It adds no
process-start identity, directory durability guarantee or storage migration. Preserve those limits
when adapting a provider; stronger mechanisms require a separate compatibility review.

## Boundaries and checks

The port is in `writer-lease.ts`; ordinary-file validation, native owner inspection, recovery,
acquisition and release have separate modules. No provider imports, account database or model is
involved. Native errors use shared CLI errors where the adapter recognizes a failure; a host still
owns its public error mapping and close-before-output behavior.

The synthetic calendar layout tests cover scope through a real root alias, real two-process
contention, normal child release and abandoned-child recovery, stale-owner recheck, conservative
permission handling, legacy refusal, cancellation cleanup, replacement preservation and symlink
refusal. These exercise native files and processes without provider credentials or an owner store.
