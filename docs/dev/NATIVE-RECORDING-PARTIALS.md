# Native recording partial storage

Use `NativeRecordingPartialStore` from `@wirecat/cli-core/persistence/native` as the native
`RecordingTransferStorage` adapter for `transferRecording`. The portable meetings module still owns
HTTP range/ETag, restart, response-length and transfer-receipt policy. The adapter owns partial
bytes, bounded metadata, prefix verification and native handle cleanup. It imports both meeting
ports and low-level file helpers; neither of those modules imports this adapter.

## Bind a host layout

```ts
import { NativeRecordingPartialStore } from "@wirecat/cli-core/persistence/native"

const storage = new NativeRecordingPartialStore(destination, locator, {
  prefix: ".example-partial-",
  persistent: true,
  maxBytes: 1024 ** 3,
  signal,
})
```

The host holds a root writer lease throughout load, open, transfer and final publication. This
adapter does not acquire a second lock or select an account. Supply a trusted archive root; parent
path validation and publication ownership stay with the host. Calls on a writer are sequential.
The host supplies `prefix`, `persistent` and `maxBytes`; there are no provider-specific defaults.

A persistent name uses SHA-256 of the UTF-8 JSON array
`[provider, account, occurrenceId, assetId]`, followed by `.part` or `.json`. An ephemeral attempt
uses a fresh UUID and writes no checkpoint metadata. Temporary files use the same host prefix
and a UUID followed by `.tmp`. Names, locator fields and settings are snapshotted before awaits.

Retaining a host's prefix retains its existing names and checkpoint format. The metadata keys
remain `locator`, `offset`, `sha256`, `validator`, `total`, with the existing locator field names.
No provider credentials, signed URLs or transport configuration belong in the locator or metadata.
Malformed/oversized metadata fails explicitly. The JSON read and write bound is 16 KiB.

## Resume and completion

`load(locator)` returns no partial when metadata is missing or persistence is disabled. Otherwise
it reads ordinary files, validates account/asset identity and hashes exactly the recorded prefix
with a 64 KiB buffer. Extra trailing bytes are permitted at load and truncated only after the
append handle and prefix have been verified again. Short reads and writes are handled in loops.
Symlinks and replacement races fail before their content can be used as a verified prefix.

The portable service decides whether a validator permits resume. Starting over atomically replaces
only the owned partial name and removes its obsolete checkpoint; it never follows that name's
symlink. The adapter never promotes or overwrites a final asset. Publication journals, manifests
and recovery remain separate host capabilities.

Each writer owns its handle. The caller must close it in `finally`; `transferRecording` does so.
Failed setup also closes acquired handles. Cancellation prevents a completion receipt and does not
prevent closing. A write that fails after making partial progress cannot later be checkpointed as
successful. Checkpoints sync data before atomically replacing metadata and syncing the directory
(on POSIX; Windows retains the existing directory-sync no-op). A late close error propagates and
clears `completed`; the caller must await successful close before acknowledging or publishing.

`path` identifies the owned partial. `completed` is populated after a successful `finish()` when a
validator exists; it is not itself a final-publication receipt. Ephemeral files and unpromoted
persistent files remain the host's cleanup responsibility. An interrupted data write may leave a
longer file than its last durable checkpoint; the next verified resume safely discards that tail.

## Verification

The adapter tests use fictional providers and an independent legacy-byte fixture. They cover
resume, account separation, restart, prefix changes, symlinks, file replacement, malformed/oversized
metadata, short I/O, no-progress writes, cancellation, truncate/setup failure, metadata failure and
late-close failure. Existing file tests exercise Windows identity normalization for read and write
handles. `check:dist` exercises the built native entry with the portable transfer service under
Node and Bun. No tests use a provider account or the owner's store.
