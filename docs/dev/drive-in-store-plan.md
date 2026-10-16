# Drive shared storage

Drive imports into the same WireCat database as Memo, Telegram and MAX. A document has one
`document:<id>` reference in that file, so tags, notes, evidence and message links act on the same
entity. Google-specific filesystem and account binding stay in Drive; indexing, knowledge and
search use Core's public services. See the [document module](DOCUMENTS.md).

## Database selection

Drive opens `storePath(env)` through the public store API and records each profile with
`saveProfile("drive", profile, { provider: "folder", account: "google-drive:<principal>" })`.
`MESSAGING_STORE` is its database override. `WIRECAT_STATE_DIR` moves the default WireCat directory;
Drive snapshots and checkpoints remain under its own state directory. Sign-ins stay separate.

`searchNotes` and combined search retain an imported Google document's URL and remote edit time.
Registered Drive folder profiles resolve through `--source drive:<profile>` in Core's search
service. Without a recorded profile, a hit retains its notes-folder scope. Documents still use
the notes search lane; the separate `--only documents` taxonomy remains in the
[source registry plan](source-everywhere-plan.md).

## Changing store files

Row numbers cannot be copied between databases. Drive's checkpoint records the absolute store
path. A different path rebuilds document references from its local snapshots under the profile
lock, without Google requests. It publishes the new checkpoint only after rebuilding, and an
interrupted rebuild can be retried without duplicating documents. An explicit rescan recovers
missing snapshots. The old database is retained.

A rebuild refuses to strand existing owner tags, notes, facts, memories or relationships in the
previous database. The owner can keep using that file through `MESSAGING_STORE`; annotation
transfer between files is not automatic. Memo also refuses attaching an ordinary disk directory
to a Drive-owned collection. No new database schema migration was needed.

Embedding processes pending notes/documents across the shared database. Drive's own search
continues to filter the selected Google account. The tools need compatible shared-store versions;
an explicit shared file does not share credentials or Google permissions.

## Evidence

- [Drive storage and linking](https://github.com/WireCatLabs/drive-cli/pull/93).
- [Core source provenance and profile resolution](https://github.com/WireCatLabs/cli-core/pull/1368).
- [Cross-tool executable checks](https://github.com/WireCatLabs/cli-testing/tree/main/performance/documents/drive-shared-store).
