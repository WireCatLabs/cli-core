### Added

- **A meetings service declares what `meetings create` and `meetings update` take.** `MeetingManagementPorts.fields`
  names, for `create` and `update`, the portable fields the service reads (`title`, `kind`, `startTime`,
  `durationMinutes`, `timezone`, `agenda`) and its own settings (`MeetingSetting`: a snake_case name, a description,
  and `choice` with its values, `boolean` or `text`). The settings are given as `--setting <name>=<value>`, repeated
  for more; `--setting`'s description and the command's help list them, so `commands --json` shows them too. The
  receipt's `change.settings` carries them, and it marks `meeting.title`, `meeting.agenda` and `meeting.join_url`
  untrusted. A port that declares nothing reads every portable field and no setting.
  See [Remote management](../docs/dev/MEETING-PROVIDERS.md#remote-management).

### Changed — may break callers

- **A meeting needs no title, and a service that cannot schedule creates meetings that start now.**
  `meetings create` and `createMeetingManagement` no longer require a title. A service that declares no `startTime`
  (Meet) creates an instant meeting that starts when it is sent, after the owner's question
  (`createMeetingManagement(scope, ports, { now })` sets the clock). A service that can schedule (Zoom, or a port that
  declares nothing) still needs `--start-time` or `--kind instant`, so a forgotten start is an error, not a live
  meeting. The refusal names the options: `give --start-time, or --kind instant for a meeting that starts now`.
- **A field the service does not take is refused with `validation_error`, naming the options it takes.** Before, every
  portable field reached every port. A blank `text` setting is refused unless it is declared `clearable`.
  `validateMeetingChange(change, create, { declared })` takes the declaration; called with two arguments it keeps the
  portable fields.
- **`meetings create|update|cancel` ask the owner after the change is validated.** A change the service cannot take
  is refused without the question. `MeetingMutationOptions.confirm` runs between validation and dispatch, only when
  the write will go; the commands pass `askFirst` there.
- **The `google-meet` provider's tool is `gcal`.** Google Meet has no tool of its own: its meetings are part of
  Google Calendar's tool, since every meeting is on the calendar. A hint that opens a Meet meeting now points at `gcal`.
