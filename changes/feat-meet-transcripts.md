### Added

- **A document sync takes a saved query beside its selected folders** (`SyncOptions.query`, `SourceQuery`). `include`
  imports every file the query lists wherever it sits, read again on each sync, and drops one that stops matching;
  `exclude` keeps matching files out even inside a selected folder. A profile without a query keeps its checkpoint.
  drive uses it for Google Meet transcripts and Gemini notes that live in organizers' Drives.
- **A meeting transcript can name the Drive file it was saved as** (`TranscriptInput.driveFileId`). The store links the
  meeting to that file's document whichever arrives first, and `search all` then shows the meeting once instead of the
  meeting and the same Google Doc. A document whose meeting is not among the hits still shows. A newer transcript
  that names another file replaces the link.
