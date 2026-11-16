### Added

- **`personHistory(store, "person:<id>")`** gives what happened with one person lately, across every source in scope,
  newest first: their one-to-one messages, mail, calendar events and recorded meetings and calls, the same reads a
  deal's and an organization's context make. `limit` (10 by default) ends a page and `next` is the `until` of the
  older one; `since`, `until`, `accounts` and `deniedKinds` narrow it, and `coverage` says what was read.
- **A touch of a deal's context, and of a person's history, carries what was said**: a message's `text`, and on a
  recorded call its `call` (direction, the employee, the other side's number), `duration_ms` and the start of its
  transcript as `text`. A calendar event a call was held for carries them too.
- **A recorded meeting in a person's context has `snippet`**, the start of its transcript on one line, beside
  `has_transcript`.
