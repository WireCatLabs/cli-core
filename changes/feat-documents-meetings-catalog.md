### Added

- **Every document and every meeting of every account, one list each.** `listDocuments`, `listDocumentSources` and
  `showDocument` (`./services`) list the documents of Drive accounts, notes folders, added sources and imports with
  their source, folder, kind, size, link and whether the store holds their text, page them with a total, and give
  each account's folder tree with counts. `listMeetingEntries` and `showMeetingEntry` list meetings, calls and calendar
  events as one row per real meeting in a time window (overlap, newest or oldest first), with participants and their
  person refs, join links, recording, transcript and summary flags, linked documents and the findings waiting on the
  owner; `show` adds the transcript lines with their times. `documentListRequest`, `meetingListRequest` and their
  query registries (`./cli`) turn a list's words into those requests; `store.listings` holds the SQL. See
  [Listings](../docs/dev/LISTINGS.md).
