### Added

- **The events list's query, from `@wirecat/cli-core/calendar`.** `EVENT_TYPES`, `EVENTS_QUERY`,
  `EVENTS_QUERY_NOTE`, `eventsFilter` (with `accountIds` for several accounts), `eventsAnswer`, `eventOf`,
  `eventAnswer`, `sourceAccounts` and the `ReadAccount` type, so a tool that lists the events of several calendar
  accounts reads the same query and answer as `events list` instead of copying them.
