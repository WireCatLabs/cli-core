### Added

- **An agent schedule runs in any coding agent whose own limits hold it to the CLIs' commands.** `schedule agent
  <name> <harness>` takes `claude`, `gemini` and `opencode`, the ids WireCat Desktop's Agents page uses, each in the
  one-shot mode its vendor documents and with its own model flag. gemini is held by an admin policy, named in a system
  settings file through `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, that denies every shell command but the CLIs', any chained or
  variable-setting one, file writes and web reads, and turns off the owner's allowed tools, MCP servers and yolo mode.
  opencode is held by `OPENCODE_CONFIG_CONTENT`, which denies everything but the CLIs' commands. `codex`, `cursor`,
  `grok`, `openclaw`, `hermes` and `kimi` are listed and refused (`agent.unrestricted`), as the owner ruled: their docs
  show no way to deny every other command in a one-shot run. GLM has no agent CLI of its own; Z.ai's plan runs it inside
  these agents.
- **`schedule agents list`** answers every agent: `id`, `name`, `programs` (the names looked for on PATH),
  `reports_cost`, `restricted`, `restricted_reason` (why it is refused, else null), `installed` and `path`. A client
  reads it instead of keeping its own list.
- **`HARNESSES`, `isHarness`, `harnessInfo`, `harnessOfArgv`, `harnessesOn` and `reportsCost`** in
  `@wirecat/cli-core/cli`, so a CLI that makes agent schedules (memo's digests) checks an agent against the same list
  and reads which agent a saved schedule starts.
- **`schedule list` names each agent schedule's `harness`** and whether it `reports_cost`.

### Changed — may break callers

- **Every list and search in the TypeScript API answers a `ListResult`** (`{ items, hasMore, nextOffset?, nextCursor? }`,
  cli-base WC-OUT-25), and `cli-dev lint` checks it (`result-shape`). The `--json` answers stay as they were. A store
  list reads one row past the page, so `hasMore` is exact, and takes an `offset`.
  - The store: `memories.list` and `memories.search`, `facts.list`, `agentActions.list`, `proposedActions.list`,
    `records.list`, `contracts.list`, `transactions.list`, `orders.list`, `products.list`, `subscriptions.list` and
    `subscriptions.prices`, `wallets.list`, `finance.invoices` and `finance.payments`, `deals.list` and `deals.find`,
    `tasks.find`, `business.find`, `searches.searchHistory` and `meetings.search` answered an array; read `.items`.
  - `searchEvents` and `searchNotes` (`EventsFound`, `NotesFound`): `hits`, `has_more` and `next_offset` are `items`,
    `hasMore` and `nextOffset`.
  - The knowledge service: `memories`, `facts` and `searchMemories` answer a `ListResult`; `searchMemories`'
    `limit_reached` is `hasMore`.
  - The attachments, conversations and tags services' `list`, the searches service's `history` and `TaskList` say
    `hasMore` where they said `has_more`.
  - `pagedList(path, settings, { items, hasMore })` takes `hasMore` where it took `has_more`.
  - `meetingsList(store, filter)` takes `filter.offset` where it took a page number as its third argument.
  - `participantCandidates` (`MeetingParticipantPage`): `has_more` and `next_cursor` are `hasMore` and `nextCursor`,
    absent on the last page. `MeetingProjectDiscoveryPage.hits` is `items`.
  - `ProposalKind.list` answers a `ListResult`.
  - A CRM or calendar source's page: `CrmPage` and `ChangePage` say `hasMore` and give `nextCursor` where they gave
    `nextPage`; `CrmIdPage.ids` and `ChangePage.entries` are `items`. A page that says `hasMore` with no `nextCursor`
    is refused (`invalid_response`).
- **A codex agent schedule no longer runs**, nor does one changed to start anything but a restricted agent as its
  harness finds it on PATH: the run is refused with `agent.refused`. Codex's sandbox limits where it writes, not which
  commands it runs. Make the schedule again with claude, gemini or opencode.
- **An agent works in an empty folder of its own**, not in its schedule's folder, and a timer passes the schedule
  file's SHA-256 to `schedule exec`, which refuses a file that changed since it was saved. A timer saved before this
  release has no seal and runs as before; saving the schedule again (`schedule pause` and `resume`, or an edit) adds it.
- **`<PREFIX>_READ_ONLY` holds for every process below a locked one.** On Linux a CLI also reads the starting
  environment of the processes it descends from, which a descendant cannot change, so `MEMO_READ_ONLY=0 memo …` or
  `env -u` inside an agent run stays read-only.
- **Claude never reads the owner's settings in a schedule**: `--setting-sources ""` is passed even when
  `schedule_lean_start` is false, so the owner's own allow rules cannot widen what the agent runs.
- **An agent that reports no cost lists it as unknown.** `schedule list` answers `spent_today_usd`, `max_cost_usd` and
  `max_cost_per_day_usd` as `null` for every agent but claude. `schedule agent` refuses `--max-cost` and
  `--max-cost-per-day` for such an agent (`agent.cost-unknown`), and `agentSchedule` leaves them out of its schedule.

### Fixed

- **A claude run that answers an error fails.** Claude can answer "Credit balance is too low" with `is_error` and exit
  0; the run kept the error as its report and sent it as a digest. It now fails, and the run's log keeps claude's answer.
