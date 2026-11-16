### Fixed

- **A Drive file two Drive profiles imported links to its meeting.** A Meet transcript or "Notes by Gemini" doc shared
  with two Drive profiles is two documents, and its calendar event's or meeting's `attached` link stayed unresolved:
  `search all` showed the meeting and the document apart, and the meetings filter "only with transcript" missed it.
  The link now takes the older of the documents, whichever of Drive or Calendar is saved first, and keeps it when
  either profile imports the file again. See
  [MEETING-PROVIDERS.md](../docs/dev/MEETING-PROVIDERS.md#a-meetings-drive-documents).
