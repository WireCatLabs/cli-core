# Schedules: run a command or an agent later or on a timer

Status: proposal, 2026-10-11. Nothing built. The owner's ask: the daily follow-up review is never turned on by
itself, install only suggests the command that turns it on; scheduling covers the CLI's own commands and agent
harnesses (claude, codex), on a repeat or once.

## What already exists, and what that removes

- **Keeping the store current is `serve`, not a schedule.** `max server install` writes a systemd user unit
  (Linux) or a launchd agent (macOS) that runs `serve`, which saves every new message, edit and reaction live
  ([`src/background/units.ts`](../../src/background/units.ts), [`serve-command.ts`](../../src/cli/messenger/serve-command.ts)).
  On the owner's machine it is not installed (`max server status`: `installed: false`, 2026-10-11), which is why
  the agenda lists most chats as `unsynced`. A scheduled `messages list` would be a worse copy of `serve`: it
  polls, and it reads only the chats it names. So the first suggestion after install stays `server install`.
- **What `serve` cannot do is run a judgement**: an agent reading the agenda and drafting replies, or a one-off
  heavy job (a backfill of history before `serve` started). That is what schedules are for.

## Commands

One command tree, every schedule an argv:

```sh
max schedule add <name> (--every <duration> [--at HH:MM] | --once <when>) -- <argv...>
max schedule agent <name> <harness> "<prompt>" (--every … | --once …)   # shorthand for add, see below
max schedule list                                                       # name, when, next run, last exit code, log
max schedule run <name>                                                 # run now, same environment as the timer
max schedule remove <name>
```

- `<argv>` starting with the CLI's own name (`max messages list …`) is resolved to the same binary the unit for
  `serve` uses, so a later global install does not change what runs.
- `--once` takes the same moments as `--due` (`30m`, `2d`, an ISO date). `--every` takes `30m`, `1h`, `1d`;
  `--at` pins a daily or weekly run to local time.
- `max server install` ends with one line, printed and never run: `turn on the daily follow-up review:
  max schedule agent follow-ups claude "…" --every 1d --at 08:30`. An npm `postinstall` cannot ask: installs
  run without a terminal and in CI.

### `schedule agent`

Shorthand that builds the argv for a known harness and adds what an unattended agent needs:

| harness | argv (flags from `claude --help` / `codex exec --help`, 2026-10-11) |
|---|---|
| `claude` | `claude -p "<prompt>" --allowedTools "<max read commands and MCP read tools>" --max-budget-usd <n> --no-session-persistence` |
| `codex` | `codex exec --sandbox read-only "<prompt>"` |

Any other harness goes through `schedule add -- <argv>`; the shorthand is only for the two it knows.

**It cannot send, by construction.** The unit sets `<PREFIX>_READ_ONLY=1` for the agent and everything it
starts. That is a new settings layer that can only tighten: with it, `readOnly` is true whatever the config
says, so `send`, `react`, `edit` and the MCP write tools are refused by the guard
([`src/sends/guard.ts`](../../src/sends/guard.ts), the `readOnly` branch). Today `readOnly` comes only from the
config file ([`src/cli/settings.ts`](../../src/cli/settings.ts), `fromLayers("readOnly")`), and the profile the
owner uses for sending cannot be made read-only. Message text the agent reads can say "send this"; this makes
that a refused command, not a judgement call. To check when building: that an MCP server started by the harness
inherits the variable.

The agent's answer goes to `~/.local/state/<app>/schedules/<name>/<timestamp>.md` (stdout), and the last one
is linked as `latest.md`. Where else it goes is NEED-163.

## Where a schedule lives

In the unit files, nothing in the store: `list` reads them back. No store migration, so no version to reserve.

| OS | repeat | once |
|---|---|---|
| Linux | `<app>-schedule-<name>.service` + `.timer` beside the `serve` unit, `OnCalendar=` / `OnUnitActiveSec=`, `Persistent=true` so a run missed while the laptop slept happens at wake | `systemd-run --user --on-active=… --unit <app>-once-<name> -- <argv>` (transient, gone after it runs; `systemd-run --help`, systemd 259) |
| macOS | launchd agent with `StartCalendarInterval` / `StartInterval` beside the `serve` agent | a launchd agent at that time that removes itself after the run. `at` is off by default on macOS |
| other | refused with the same message `server install` gives | refused |

`units.ts` already writes, loads and removes both kinds of unit for `serve`; schedules add a timer
variant to the same `Platform` rather than a second writer.

## Limits

- `schedule agent` refuses `--every` under NEED-164's minimum: each run is a paid model call that reads chats.
  Five minutes is 288 runs a day.
- One run at a time per schedule: a timer does not start its service again while it is still running (systemd; launchd behaves the same, I think — check when building).
- A failing run is visible in `schedule list` (last exit code) and its log, never retried in a loop.

## Order of work

1. `<PREFIX>_READ_ONLY` settings layer, with a guard test: set, `send` is refused even when the profile allows it.
2. Timer units in `units.ts` (systemd, launchd), `schedule add/list/run/remove`, tests against the unit text as
   `server` has.
3. `schedule agent` for claude and codex, report files.
4. The suggestion line at the end of `server install`, and the `follow-ups` skill naming the schedule.
5. Once-runs (`--once`), last: the most OS-specific part.
