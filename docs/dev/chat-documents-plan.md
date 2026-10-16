# Documents shared in chats

`tg <profile> chats documents list <chat>` and `max <profile> chats documents list <chat>` read
Google document links from stored messages. The shared command/service lives in Core; MAX mounts
it beside its provider-specific chat commands. No messenger history is fetched or marked read.
Consumer release versions determine when their installed executables expose it.

Each JSON item has `url`, `document_id`, `title`, `in_store`, `ref` (the message locator), `sent_at`
and `sender`. An imported linked document supplies its title; otherwise the item keeps its URL
with `title: null` and `in_store: false`. Paging uses `--limit` and `--page`. The command uses the
messages permission and is available under read-only policy.

## Link extraction and persistence

`googleDocumentLinks` is the shared URL parser. It recognizes Docs, Sheets, Slides, Forms and
Drive file URLs, including account-indexed paths and `open?id=...`. The reader and writer use
the same parser. A plain file ID in unrelated text is not a document link. Hyperlinks stored
only in formatting without a visible URL are not detected. An edited message that no longer
contains a link disappears from the list; a deleted document reads as not imported.

`store.notes.linkMessages({ documents: [{ reference, fileId }], since? })` finds matching stored
messages and writes missing message-to-document links. Repeating a pass does not duplicate them.
Its `since` bound uses the message's local insertion time, not its remote sent time.

Drive sync runs a historical pass for saved/changed document references, then links all held
documents against messages stored since its previous watermark. The watermark is captured before
the passes and saved only after completion. A persisted retry marker repeats historical linking
if a pass failed after document ingestion had already committed. Newly stored messages therefore
link to unchanged documents without re-downloading those documents.

These passes do not establish complete Google edit history. Adding a URL to an older stored
message by editing it can fall outside the insertion-time watermark; this needs an update-aware
incremental pass or an explicit historical relink.

## Evidence

- Core's command/service/store tests: `src/cli/messenger/chats-documents.test.ts`.
- [MAX command adoption](https://github.com/WireCatLabs/max-cli/pull/685) and
  [paging matrix](https://github.com/WireCatLabs/max-cli/pull/686).
- [Drive sync and recovery](https://github.com/WireCatLabs/drive-cli/pull/93).
- [Packaged cross-tool workflow](https://github.com/WireCatLabs/cli-testing/tree/main/performance/documents/drive-shared-store).
