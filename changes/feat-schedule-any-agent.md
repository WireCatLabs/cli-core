### Added

- **An agent schedule runs in any coding agent with a one-shot mode.** `schedule agent <name> <harness>` takes
  `claude`, `codex`, `gemini`, `cursor`, `opencode`, `openclaw`, `hermes`, `grok` and `kimi`, the ids WireCat Desktop's
  Agents page uses. Each starts in the mode its vendor documents for scripts (`gemini -p`, `cursor-agent -p`,
  `opencode run`, `openclaw agent exec`, `hermes chat -q -Q`, `grok -p`, `kimi --quiet -p`), with its own model flag. GLM
  has no agent CLI of its own: Z.ai's plan runs it in these agents, so it is their `--model` or their own setup. Only claude
  is limited to the CLIs' commands and codex to their folders; the others approve every command in that mode, and only
  `<PREFIX>_READ_ONLY` keeps them from sending.
- **`schedule agents list`** answers every agent a schedule may start: `id`, `name`, `programs` (the names looked for on
  PATH), `reports_cost`, `restricted`, `installed` and `path`. A client reads it instead of keeping its own list.
- **`HARNESSES`, `isHarness`, `harnessInfo`, `harnessOfArgv`, `harnessesOn` and `reportsCost`** in
  `@wirecat/cli-core/cli`, so a CLI that makes agent schedules (memo's digests) checks an agent against the same list
  and reads which agent a saved schedule starts.
- **`schedule list` names each agent schedule's `harness`** and whether it `reports_cost`.

### Changed — may break callers

- **An agent that reports no cost lists it as unknown.** `schedule list` answers `spent_today_usd`, `max_cost_usd` and
  `max_cost_per_day_usd` as `null` for every agent but claude, where codex answered 0 and the configured cap before:
  no cap could ever stop it. `schedule agent` refuses `--max-cost` and `--max-cost-per-day` for such an agent
  (`agent.cost-unknown`), and `agentSchedule` leaves them out of its schedule.

### Fixed

- **A claude run that answers an error fails.** Claude can answer "Credit balance is too low" with `is_error` and exit
  0; the run kept the error as its report and sent it as a digest. It now fails, and the run's log keeps claude's answer.
