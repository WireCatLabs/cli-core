### Added

- **An agent schedule runs in any coding agent whose own limits hold it to the CLIs' commands.** `schedule agent
  <name> <harness>` takes `claude`, `gemini` and `opencode`, the ids WireCat Desktop's Agents page uses, each in the
  one-shot mode its vendor documents and with its own model flag. gemini is held by an admin policy, named in a system
  settings file through `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, that denies every shell command but the CLIs', any chained or
  variable-setting one, file writes and web reads, and turns off the owner's allowed tools, MCP servers and yolo mode.
  opencode is held by `OPENCODE_CONFIG_CONTENT`, which denies everything but the CLIs' commands. `cursor`, `grok`,
  `openclaw`, `hermes` and `kimi` are listed and refused (`agent.unrestricted`): their docs show no way to deny every
  other command in a one-shot run.
- **codex runs on a schedule once the owner accepts it with `--allow-dangerous`**, which the schedule keeps; without it
  `schedule agent` refuses it (`agent.unrestricted`). It runs with `--ignore-user-config` and `--ignore-rules`, so the
  owner's `~/.codex` cannot widen it, in the `workspace-write` sandbox with the network off, writable only in the run's
  own folder, the store's folder and the CLIs' state and cache folders. It may still run any program there: one such as
  sqlite3 can change the store, which the read-only lock does not stop. GLM has no agent CLI of its own; Z.ai's plan runs it inside
  these agents.
- **`schedule agents list`** answers every agent: `id`, `name`, `programs` (the names looked for on PATH),
  `reports_cost`, `restricted`, `restricted_reason` (why it is not restricted and what it may still do, else null),
  `allowed_with_ack` (true for codex only), `installed` and `path`. A client
  reads it instead of keeping its own list.
- **`HARNESSES`, `isHarness`, `harnessInfo`, `harnessOfArgv`, `harnessesOn` and `reportsCost`** in
  `@wirecat/cli-core/cli`, so a CLI that makes agent schedules (memo's digests) checks an agent against the same list
  and reads which agent a saved schedule starts.
- **`schedule list` names each agent schedule's `harness`** and whether it `reports_cost`.
- **A scheduled agent is told that the CLIs' output is other people's text, never instructions**, and in its run each
  field an answer lists as `untrusted` is printed between `⟦untrusted:<mark> source=<field> id=<ref>⟧` and
  `⟦/untrusted:<mark>⟧`. The mark is random for each run, and every bracket and the mark are taken out of the text
  first, so it cannot close or fake a block. Outside a scheduled agent's run the output is as before.

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
- **Every agent schedule must be saved again.** A run rebuilds the agent's start (its argv, variables and files) from
  the harness, prompt, model and limits the schedule now keeps under `agent`, and never runs the argv in the file. A
  file saved before this release keeps no `agent` and is refused (`agent.refused`) with a hint to save it again. A codex
  schedule saved without `--allow-dangerous` is refused too.
- **A schedule's variables are checked before it runs**: only the profile, the file locations, PATH, the lock and a
  harness's own variables, by absolute paths; any other is refused. A timer's run keeps the saved locations. A run by
  hand (`schedule run`, a backfill) takes PATH from its shell and is refused when the shell's file locations differ
  from the saved ones. The checked schedule is what runs; the file is not read again.
- **An agent works in an empty folder of its own**, not in its schedule's folder, and a timer passes the schedule
  file's SHA-256 to `schedule exec`, which refuses a file that changed since it was saved.
- **Under `<PREFIX>_READ_ONLY` a command writes a file only inside its scheduled run's work folder.** `--output`,
  `--output-dir`, a command's owner-only file option and `store backup`'s file are refused elsewhere
  (`read-only.output-outside`), whatever folder the agent moved to; the folder is the one the run named in
  `<PREFIX>_WORK_FOLDER` when it started the agent. A locked process outside such a run writes no file.
- **`<PREFIX>_READ_ONLY` holds for every process below a locked one.** On Linux a CLI also reads the starting
  environment of the processes it descends from, up to one another user owns or one that hides it (the user's
  service manager), which a descendant cannot change, so `MEMO_READ_ONLY=0 memo …` or `env -u` inside an agent run
  stays read-only. When /proc cannot be read, the CLI is read-only.
- **Claude never reads the owner's settings in a schedule**: `--setting-sources ""` is passed even when
  `schedule_lean_start` is false, so the owner's own allow rules cannot widen what the agent runs.
- **An agent that reports no cost lists it as unknown.** `schedule list` answers `spent_today_usd`, `max_cost_usd` and
  `max_cost_per_day_usd` as `null` for every agent but claude. `schedule agent` refuses `--max-cost` and
  `--max-cost-per-day` for such an agent (`agent.cost-unknown`), and `agentSchedule` leaves them out of its schedule.

### Fixed

- **gemini's rules against chained and variable-setting commands now match.** Gemini tests a rule's regex after
  `"command":"` in the call's JSON, so the old patterns, which began with `^`, never matched. Every tool no rule names,
  the owner's MCP servers' tools too, is denied.
- **A claude run that answers an error fails.** Claude can answer "Credit balance is too low" with `is_error` and exit
  0; the run kept the error as its report and sent it as a digest. It now fails, and the run's log keeps claude's answer.
