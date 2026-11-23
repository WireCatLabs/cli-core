### Fixed

- **A sync keeps the thread replies it read when it is stopped.** A messenger's `threadReplies` may answer in
  batches (an async iterable); `messages sync` saves each one as it comes and moves the thread point only after the
  last, so a stopped or killed sync keeps what it read and the next one reads from the same point. A plain array still
  works.
- **A failed server search says what the messenger refused, by its keys.** Each `failed` entry carries
  `error: {code, reason?}`, and the note reads `server search incomplete: search_failed (permission_error:
  oauth.scope-missing)`. The provider's own words still stay out.
