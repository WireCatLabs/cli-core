### Added

- **Mail can be a meeting's notes.** A mail rule's `meeting_notes: "<provider>"` saves each email it matches as a
  meeting of that provider too, in the account named by the mailbox's address, once at the end of every mail sync;
  `saveMeetingNotes(store, address, rules, { since })` reads mail stored earlier the same way, and a provider that
  fails is a warning, never a failed sync. The first provider is `telemost`: Yandex Telemost mails its notes from
  `keeper@telemost.yandex.ru` (`MEETING_NOTES`). The notes give the day, not the hours, so the meeting takes its times
  from the event it is linked to, or from the owner's one calendar entry in the same room that day (in Moscow's zone
  or the computer's); otherwise it starts at the day's start with `metadata.time_precision: "day"`, and no event is
  made for it. The saved notes are cleaned as calendar text is: links without their queries, passcode lines dropped.
- **`MeetingSource.createsEvents: false`** links a source's meetings to an event the owner already has and never
  makes one; `linkEvent` takes `{ create: false }` for it.
- **`telemost` is a provider** (kind `meetings`).
