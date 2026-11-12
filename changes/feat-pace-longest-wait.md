### Added

- **`waitForTurn` takes `longestWaitMs`.** A CLI whose caller is often an agent refuses a long pace wait sooner than
  the five minutes a run sits out: b24 refuses past a minute, so it can use the shared pace instead of its own copy.
