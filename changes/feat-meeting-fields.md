### Added

- **A meetings service declares what `meetings create` and `meetings update` take.** `MeetingManagementPorts.fields`
  names, for `create` and `update`, the portable fields the service reads (`title`, `kind`, `startTime`,
  `durationMinutes`, `timezone`, `agenda`) and its own settings (`MeetingSetting`: a snake_case name, a description,
  and `choice` with its values, `boolean` or `text`). The settings are given as `--setting <name>=<value>`, repeated
  for more; `--setting`'s description and the command's help list them, so `commands --json` shows them too. The
  receipt's `change.settings` carries them. A port that declares nothing reads every portable field and no setting.
  See [Remote management](../docs/dev/MEETING-PROVIDERS.md#remote-management).

### Changed — may break callers

- **A meeting needs no title, and a create with no start starts now.** `meetings create` and `createMeetingManagement`
  no longer require a title. A create with no `--start-time` and no `--kind` is an instant meeting that starts now
  (`MeetingCreateFields.instant`, true by default; `createMeetingManagement(scope, ports, { now })` sets the clock).
  The validated create always carries `kind` and `startTime`. A caller that relied on the refusal of a create without
  a start gives `kind: "scheduled"` to keep it; a missing title is no longer refused.
- **A field the service does not take is refused with `validation_error`, naming what it takes.** Before, every
  portable field reached every port. `validateMeetingChange(change, create, { declared, now })` takes the declaration;
  called with two arguments it keeps the portable fields.
- **`meetings create|update|cancel` ask the owner after the change is validated.** A change the service cannot take
  is refused without the question. `MeetingMutationOptions.confirm` runs between validation and dispatch, only when
  the write will go; the commands pass `askFirst` there.
- **The `google-meet` provider's tool is `gcal`.** Google Meet has no tool of its own: its meetings are part of
  Google Calendar's tool, since every meeting is on the calendar. A hint that opens a Meet meeting now points at `gcal`.
