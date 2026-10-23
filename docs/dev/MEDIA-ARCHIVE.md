# Independent media archives

Use an independent media archive when you need message files to survive the source message or its
download link. The shared messenger commands save files into a chosen directory, record their sizes
and SHA-256 checksums, and verify every retained copy before adding more. The message store does not
own archive paths, so deleting a message or clearing stored history cannot delete these copies.

## Save and verify

`attachments download <dir>` walks the active account's available chats and messages. Repeat
`--chat <chat>` to select chats, and use `--since-time <ISO timestamp with zone>` for an inclusive
lower time bound. WhatsApp reads the history already held locally; keeping its background receiver
running is still necessary to receive new messages. Telegram and MAX read their available history.

```sh
chat example attachments download ./media-archive --chat "Example group" --since-time 2026-10-01T00:00:00Z
chat example attachments check ./media-archive --offline --json
```

Downloads never overwrite final files. A rerun rehashes existing copies and downloads only missing
identities. A missing or changed retained file stops the download before it contacts the messenger;
choose a new destination and preserve the original directory for inspection. `attachments check`
rehashes all manifests without connecting and returns a nonzero exit code for missing or changed files.
An empty folder without manifests is `not_found`, rather than a successful verification.

A provider or filesystem failure stops the run with an error. Completed files remain committed and a
rerun continues by identity. Current messenger streams expose no range validators, so an interrupted
file restarts from byte zero. The archive never appends an unverified remote suffix. A time-paged
history that cannot advance fails explicitly, rather than skipping messages at a saturated timestamp.
Completion covers the history the selected reader can see; it cannot prove that a messenger retained
every old message or file. Individual files are limited to 64 GiB.

## Daily backups on Linux

Every messenger opts in explicitly. Installing creates a systemd user service and persistent daily
timer, but starts nothing. The default start time is 03:00 UTC; use `--at HH:mm --timezone <IANA zone>`
to choose another. The timer runs the captured executable and profile with a six-hour timeout.

```sh
chat example attachments jobs install ./media-archive --chat "Example group" --at 03:00 --timezone UTC
chat example attachments jobs start ./media-archive
chat example attachments jobs status ./media-archive
chat example attachments jobs stop ./media-archive
chat example attachments jobs uninstall ./media-archive
```

Use the same profile, destination and location environment for later timer operations. A timer captures
only application configuration/state/cache and shared-store location variables, never credentials.
Start enables it for subsequent user sessions. Running while logged out depends on the machine's user
service configuration; the command does not change that configuration. Stop prevents future runs;
an active download finishes. Uninstall requires a disabled, inactive timer and an inactive service.
It leaves the archive intact. Changed schedules or executable paths require stop, uninstall and install.
Foreign or edited unit files are preserved. Non-Linux platforms can run downloads manually.

## Move older images

Use `attachments move <dir> <archive-dir> --before-time <ISO timestamp with zone>` to move images
whose message date is strictly before the cutoff into another verified archive. Photos and attachments
with an `image/*` MIME type are selected; other files and images at the cutoff stay in place.

```sh
chat example attachments move ./media-archive /mnt/archive/older-images --before-time 2026-10-01T00:00:00Z --dry-run
chat example attachments move ./media-archive /mnt/archive/older-images --before-time 2026-10-01T00:00:00Z --timeout 6h
chat example attachments check ./media-archive --offline
```

The preview reports selected counts and bytes without creating the destination. The move verifies
both archives, copies and verifies each selected image, durably records its new location in the source
manifest, then removes the verified local bytes. It never overwrites an existing destination file.
Completed moves survive interruption; repeat the command to finish. Source manifests remain small
relocation records, so subsequent downloads verify the moved copies and do not download them again.
Further moves from the destination are supported; checks follow the chain and lock all linked folders.
Cycles and conflicting destination copies are refused. These operations never contact a messenger.

Keep linked archives available at their recorded paths: offline storage makes verification fail and
stops downloads from silently recreating duplicate copies. Use another filesystem to free space on the
original disk; moving within one filesystem changes which folder holds the bytes. Images from earlier
draft archives without a recorded message date are left in place, counted as `undated`, and yield
`complete: false`. The command does not guess dates from file modification times.

## Storage and recovery contract

Each file identity contains provider, account, chat, message and attachment position. SHA-256 of a JSON
array of those fields names `<identity-hash>.bin` and `.media-archive-<identity-hash>.json`. The manifest
contains `version: 1`, those identity fields, attachment kind, basename, byte size and SHA-256.
New downloads also retain the canonical UTC `messageTime` and, when available, normalized `mime`.
An optional absolute `relocatedTo` directory points to another scoped manifest and verified copy.
Earlier manifests without these optional fields remain readable and verifiable.
It contains no sender text, original filename, URL, media key or provider reference. This format is
independent of Zoom's recording manifests.

One canonical destination has one native writer lease under `.media-writers`, shared by downloads,
rotation and verification. Linked folders are locked in canonical path order after discovering and
rechecking relocation records; at most 64 archive locations may be linked in one operation.
Stale leases use the ordinary native lease recovery rules. Files use
`NativeRecordingPartialStore` and `NativeRecordingPublication` with `.media-partial-` and
`.media-publication-` prefixes. A completed checkpoint and scoped publication record recover a crash
before or after linking the final file. A final file without a manifest or complete recovery evidence
is refused. Manifests and unit files use atomic, non-overwriting publication and ordinary-file reads.

The `services` export exposes `archiveMedia`, `checkMediaArchive`, `moveMediaArchive`, `MediaArchivePorts`,
`MediaArchiveOptions`, `MoveMediaArchiveOptions`, `MediaArchiveEntry` and `MediaIdentity`. Ports are narrow chat/account and
message/download services. The `background` export exposes the provider-neutral daily unit planner
and manager; machine calls are injected for tests. Archive copies are deliberately not registered as
retained attachment paths: extraction and retained-file transfer continue to use ordinary downloads.

See [retained attachments](../attachments.md) for reading and indexing an ordinary downloaded file.
