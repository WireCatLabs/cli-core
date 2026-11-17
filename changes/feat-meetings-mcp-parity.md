### Added

- **The MCP `meetings_list` and `meeting_show` read the service, as `meetings list` and `show` do.** A host passes
  `callMeetingTool` the run's `accountId`, its `source` and its stop `signal` (and `timezone`, `now`, `offline`); the
  two tools then take the same `backend` (`archive`, `server` or `both`, untyped meaning both with a fall-back to the
  store), keep what the service returns, say `found_in` on each item and hand the service the signal, so a stopped
  read ends the call. Every tool then reads that account only: an `account_id` naming another one is refused, and a
  `source` without `accountId` is a configuration error. Without them the tools read the store as before; a typed
  `backend: "both"` says so in `missing`, and `backend: "server"` is refused. The two tools now declare
  `openWorldHint`, and their descriptions no longer say "stored".
- **`meetingAnswerBody(command, value)`** from `@wirecat/cli-core/cli`: what the shared meetings commands `write`, as
  the host's answer body. An envelope stays as it is, a `listed()` page becomes a list answer whose `page.next` step
  reruns the command at the next page, and any other value is one item, with a packet's own `next`, `missing` and
  `meta` (`meetings people`) lifted onto the answer. `addMeetingCommands` now hands `write` the running command as a
  third argument, so a host passes it straight on. It replaces zoom-cli's `bodyOf` and gcal-cli's `answerOf` for the
  meetings commands.
