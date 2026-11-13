# Listings

What a page that shows "everything of one kind" reads: every document the store holds, and every meeting, call and
calendar event. Commands are thin over the services in `src/services/listings.ts`; the SQL is in
`src/store/sqlite/document-listing.ts` and `src/store/sqlite/meeting-listing.ts` (`store.listings`). memo's
`documents list|show|sources` and `meetings list|show` are the commands.

## Documents

- **Rows.** Every `documents` row that is not deleted, not a folder and still active in its source's catalog: Drive
  files, notes folders' files, sources added by hand and imports. A catalog-only Drive file is a row with
  `has_text: false`.
- **Where it is.** The document's preferred file (the owner's pin, else the newest live one) gives `path`, `folder`,
  `url` and the source's edit time (`source_modified_at`).
- **Kind.** Worked out in SQL from the MIME type and the extension (`DOCUMENT_KIND_SQL`); a document a meeting saved
  as its transcript, and a `.vtt` or `.srt` file, is `transcript`.
- **Text.** A `text:` term (or a bare word) runs the notes search over documents first (`store.notes.matchingRefs`,
  up to 2,000 hits) and the list keeps the search's order; past that cap the total is `gte`.
- **Folders.** `documentSources` reads one path per document and counts folders in JS, cut at `depth`.

## Meetings

One row per real meeting:

- A calendar event with its copies in every calendar account is one row (`event:<id>`).
- A meeting from a meeting provider joins the event it is linked to (`meetings.event_id`) when that event has a
  calendar copy. Otherwise it joins the event whose live copy has exactly its room (`join_key`, never empty) and
  overlaps its time; a recurring room's other occurrences never match. Otherwise it stays on the event made from it,
  or on a row of its own (`meeting:<account>/<id>`).
- `kind`: `call` for a phone import's call (an entry of type `call`, or a meeting of a `phone` account), `meeting` for a
  row with a meeting, else `event`. Messenger calls are not stored, so they are not listed.
- **Window.** A row is listed when it overlaps the window (`ends after from`, `starts before to`); all-day events are
  compared by their local days as `events list` compares them (`eventWindow`, shared with `listEvents`).
- **Pages.** One query names the rows of a page and one counts them; everything a row shows (copies, meetings,
  participants, documents, findings) is read once per page, never once per row. A title term is matched folded in
  JS, since SQLite folds ASCII only.

Measured on a synthetic heavy store in cli-testing,
[`performance/desktop/documents-meetings`](https://github.com/WireCatLabs/cli-testing/tree/main/performance/desktop/documents-meetings).
