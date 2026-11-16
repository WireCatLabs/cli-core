### Fixed

- **A documents sync with a deadline shorter than its margin moves on.** The run's budget stops 5 s or more before
  the deadline, and it was asked before the first folder listing and the first file read, so `sync --timeout 3s`
  said "sync again" forever with nothing done. Each call now makes its first listing and its first read while one
  request still fits before the deadline itself, as it already did for the entry bound. See
  [Walks over several syncs](../docs/dev/DOCUMENTS.md#walks-over-several-syncs).
