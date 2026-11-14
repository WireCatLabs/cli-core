### Added

- **`stats calls show` reports a business's phone calls as one JSON answer (`call_stats`).** A CLI whose meetings are
  calls (pbx, beeline) mounts it with `addCallStatsCommand` from `@wirecat/cli-core/cli`. It counts calls by
  direction and outcome; per employee the calls placed, answered and rung but not answered, with talk and wait time;
  calls by hour and by day in `--timezone`; missed incoming calls and whether the client was called back within
  `--within` (default 1d), even when the callback falls after `--until-time`; and answered calls shorter than 30
  seconds. A number the phone system does not record, such as Beeline's outcome and wait, is left out and
  counted under `known`, never shown as zero. The parts are separate: `callOf` reads a meeting as a call, `aggregateCallStats` is
  the arithmetic, `meetingCalls` on the store reads the selection, and `readCallStats` joins them.
