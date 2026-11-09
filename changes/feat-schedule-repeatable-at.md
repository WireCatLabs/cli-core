### Added

- `schedule agent|command --at` repeats: `--at 08:30 --at 18:00` runs twice a day, `--at 'mon,fri 09:00'` (or one
  `--at` per weekday) on several days, all on one timer: one `OnCalendar=` per time under systemd, an array of
  `StartCalendarInterval` under launchd, one trigger per time in Task Scheduler. `schedule list` says
  `daily at 08:30, 18:00` or `weekly on Mon, Fri at 09:00`. One `--at` is saved and listed as before.
- `schedule pause <name>` takes a schedule off its timer and keeps it; `schedule run` still runs it, `schedule resume`
  puts it back. `schedule list` marks it `paused: true`.
- `schedule run <name> --no-notify` keeps the result here: no route and no desktop notice. `--deliver-to <route>`
  (repeatable) sends it along only those, which must be the schedule's own, whatever its `--notify-on` says.
- `templates show|edit|preview|reset report/<schedule>`: an agent schedule's own digest templates. A run of that
  schedule renders with them, else with the owner's `report/morning-digest`, else with the shipped ones; `templates
  show` and `list` call that middle case `source: "inherited"`. A schedule named after another message's key
  (`weekly-gaps`) has no key of its own, and a removed schedule's templates can still be shown and reset.
- For a tool that keeps its own digests (memo): `agentSchedule`, `writeSchedule`, `pauseSchedule`, `removeSchedule`
  and `runScheduleNow` build, save, pause, remove and run an agent schedule as the `schedule` commands do (the routes
  and the day's cost cap checked the same way); `slotsOfAt` reads one `--at`; `parseRoute` and `routeText` read a
  route; `slotsOf`, `calendarOf`, `runsBetween`, `previousRun` and `nextRun` read a calendar schedule's times.

### Changed — may break callers

- `template.source` gains `inherited`. A schedule's `When` gains `{ calendar: Slot[] }` for more than one time; code that switches over every `When` needs
  the new case, or `slotsOf` for any calendar shape. A host's `reportTemplates` now gets the schedule's name as its
  second argument.
