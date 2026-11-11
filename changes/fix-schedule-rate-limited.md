### Fixed

- **A daily or one-off schedule sits out a wait the provider asked for.** A timer run that failed with `rate_limited` and a `retry.after_ms` failed for the day. `schedule exec` now waits that long, if it is at most six hours, and runs once more; `last.json` keeps the wait as `retryAfterMs`. A run by hand and a schedule that repeats still fail at once.
