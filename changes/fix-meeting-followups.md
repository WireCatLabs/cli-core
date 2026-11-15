### Added

- **`calendarWriteToolsFor(conferences)` lists the calendar MCP write tools with `conference` for those services.**
  `calendarWriteTools` no longer shows `conference`, so an agent of a calendar that cannot make meeting links is not
  offered the field. A host whose writer declares `conferences` lists `calendarWriteToolsFor(writer.conferences)`.
  See [Calendars](../docs/dev/CALENDARS.md#commands-and-mcp-tools).
- **`MeetingCommandDeps.signal` passes the run's stop signal to `meetings create|update|cancel|invitation`.** Without
  it a `--timeout` or Ctrl-C did not reach the service call. Pass the same signal the host gives its other reads.
- **The calendar writer contract checks meeting links.** A writer that declares `conferences` must return the new
  link (`joinUrl`) on a create and on a change.

### Fixed

- **Meeting text from other people is marked untrusted in more reads.** `meetings passage` marks each cue's
  `speaker_name` and `text` in its structured answer (`--json`, MCP `structuredContent`, `batch`), and `events list` under a meetings tool marks each event's title,
  description and location. `--json <fields>` keeps the `untrusted` lists (cli-base 0.102.1).
- **A service's rate limit is named as one.** `meetings list` answers from the store with the issue
  `meetings.server-rate-limited` (`rate_limited`) instead of `meetings.server-failed`, and `meetings show` of a meeting
  the store does not hold fails with the service's `rate_limited` error instead of `not_found`.

### Changed — may break callers

- **`meetings people` and MCP `meeting_people` answer the bounded path's row on a store without bounded participant
  search.** Such a store (a custom `MeetingStore` without `participantCandidates`) returned its stored rows
  (`displayName`, `meetingId`, `metadata`…), so the `untrusted` names matched none of their keys. Its rows now have
  `participant_id`, `meeting_id`, `identity_id`, `display_name` and `email`; `person` is left out, as that store does
  not know a participant's person.
