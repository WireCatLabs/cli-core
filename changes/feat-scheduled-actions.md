### Added

- **Cancel, edit and send now a scheduled message: `messages scheduled cancel <chat> <scheduled-id...>`,
  `messages scheduled edit <chat> <scheduled-id> [text] [--at-time <time>]` and
  `messages scheduled send <chat> <scheduled-id...>`.** Before, a scheduled message could only be listed, and the
  owner cancelled one in the app. A scheduled message has an id of its own: `messages edit` on it failed, and
  `messages delete` with the same number would have deleted an old, sent message. Each command takes only the ids
  `messages scheduled <chat>` lists and checks them against that list before anything changes; an unknown id is
  `not_found` and points at the list. Cancelling counts and asks as a delete does (`--allow-dangerous` at an `ask`
  level), sending now as a send. An edit with only `--at-time` keeps the text, and one with only the text keeps the
  time. The keys are `messages.scheduled.cancel`, `.edit` and `.send`; the answers are the entities
  `scheduled_cancellation`, `message_write` and `scheduled_send`. An adapter adds them through the optional port
  group `ScheduledChanges` (`cancelScheduled`, `editScheduled`, `sendScheduled`); a messenger without it answers
  "this messenger cannot …". Needs cli-base with `scheduled` as a resource word, for `cli-dev lint`.

### Fixed

- **The MCP command search ranks the shorter name first on a tie**, so "send message" finds `messages send` before
  `messages scheduled send`.
