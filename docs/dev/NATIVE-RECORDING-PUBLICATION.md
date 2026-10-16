# Native recording publication and recovery

`NativeRecordingPublication` from `@wirecat/cli-core/persistence/native` shares native publication
mechanics across recording providers. It knows recording fingerprints and scoped checkpoints, but
no provider manifest format. The host supplies a codec, final filename, journal prefix, limits and
an evidence projection. Keep the same prefix, scope and codec to retain a legacy journal format.
The journal name is the prefix plus SHA-256 of the JSON array
`[provider, account, occurrenceId, assetId]`, followed by `.json`.

## Bind a host

```ts
import { NativeRecordingPublication } from "@wirecat/cli-core/persistence/native"

const publication = new NativeRecordingPublication(root, locator, {
  prefix: ".example-promotion-",
  filename: "audio.bin",
  maxBytes: 1024 ** 3,
  metadataLimit: 32768,
  codec: {
    encode: value => JSON.stringify(value),
    decode: validateHostIntent,
  },
  evidence: value => ({ size: value.size, sha256: value.sha256, validator: value.validator }),
  signal,
})
```

The decoder must validate the entire host record, including account/meeting/asset scope, final
filename and the expected provider metadata. It returns the host type or throws; a type cast is
not validation. Codecs must be synchronous and deterministic. Options and locator scope are
snapshotted before I/O. The host chooses a positive metadata bound up to 1 MiB. Reads loop over
short I/O and reject oversized, malformed, replaced and symlinked journals. Writes validate the
encoded value, sync their owned temporary file, atomically rename and sync the directory.

## Publication order

Hold one root writer lease throughout partial loading, transfer, journaling, publication and
manifest commitment. Supply a trusted archive root; parent directories and that lease are the
host's responsibility. Operations and callbacks are sequential. This is cooperative filesystem
ownership, not protection against a process actively modifying an opened inode or racing every
path operation. Ordinary-file checks use the shared Windows identity normalization.

After the transfer writer has successfully closed:

1. For recoverable transfers, `write(intent)` persists the scoped intent using the host codec.
2. `publish(partialPath, receipt, commit)` verifies the complete partial size and SHA-256, syncs
   its bytes and hard-links the final path without overwriting an existing entry.
3. The adapter checks path identities and syncs the directory before calling `commit()`.
4. The host callback durably commits its manifest. Only after it resolves does the adapter recheck
   identities, remove the owned partial name and sync the directory again.

A callback must complete all required manifest writes, handle closes and directory syncs before
resolving. The adapter cannot inspect the host's durability contract. It resolves only after its
own required cleanup, close and sync operations succeed. Cancellation and late errors propagate;
no successful receipt is returned after them. Cancellation never skips handle closure.

Weak-validator/ephemeral transfers can publish without a journal, but cannot be recovered through
an ownership record. A failed link preserves the existing final. The adapter does not remove a
final on any failure, and does not remove a replacement at the partial or temporary path.

## Recovery

When the host finds an unmanifested final, call
`recover(partialPath, loadPartial, commitIntent)`. It reads the host-decoded journal, requires a
strong validator and an exact matching scoped checkpoint, then independently verifies the complete
partial and final bytes against the journal fingerprint. Missing or inconsistent evidence fails
before the manifest callback and preserves the files. Directory sync, commitment and owned-partial
cleanup follow the publication ordering above. The method returns the decoded intent only after
successful commitment and cleanup.

The checkpoint loader must verify its persisted prefix; `NativeRecordingPartialStore.load` does.
Recovery also checks the complete file, so uncommitted trailing bytes cannot be acknowledged.
The journal and checkpoint remain after successful publication for compatibility with existing
layouts; they are not independent proof of a manifested final. Normal archive reruns use the host
manifest. Windows keeps the existing directory-sync no-op; installed platform checks must verify
the Windows binding as well as the native POSIX path.

## Verification

Synthetic tests exercise a fictional provider, an independently encoded legacy journal, no-overwrite
publication, interrupted commitment, scoped checkpoint mismatches, changed bytes, symlinks, path
replacement, short reads, cancellation, journal/data/directory failures and late close errors.
Native fault injection lives alongside Core's implementation: mocks in a consumer do not intercept
filesystem imports inside its installed Core dependency.
