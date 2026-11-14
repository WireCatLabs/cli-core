### Added

- **A meetings service declares what `meetings create` and `meetings update` take.** `MeetingManagementPorts.fields`
  names, for `create` and `update`, the portable fields the service reads (`title`, `kind`, `startTime`,
  `durationMinutes`, `timezone`, `agenda`) and its own settings (`MeetingSetting`: a snake_case name, a description,
  and `choice` with its values, `boolean` or `text`). The settings are given as `--setting <name>=<value>`, repeated
  for more; `--setting`'s description and the command's help list them, so `commands --json` shows them too. The
  receipt's `change.settings` carries them, and it marks `meeting.title`, `meeting.agenda` and `meeting.join_url`
  untrusted. A port that declares nothing reads every portable field and no setting.
  See [Remote management](../docs/dev/MEETING-PROVIDERS.md#remote-management).

- **`events create|update --conference <service>` add a meeting link to an event.** A calendar writer that can make
  one names its services in `CalendarWriter.conferences` (`google-meet`), and `options.writes.conferences` mounts the
  option with them as its choices. It is a change of its own, so `events update event:42 --conference google-meet`
  needs no other field. The writer gets `conference: { provider, requestId }` with a new request id each time, never
  the event's id. An event that already has a link is refused (`event.conference-exists`), so the attendees' link is
  never replaced. See [Calendars](../docs/dev/CALENDARS.md#commands-and-mcp-tools).

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

### Security

- **The shared meetings answers mark other people's text untrusted.** `meetings show` marks participants' names and
  emails, the chat, the series title, attachment and document names; `meetings transcript` marks each line's text and
  speaker; summaries mark their text; `meetings export` marks `content`; `meetings people` marks each match's
  `display_name` and `email`. In a scheduled agent's run they arrive between the run's markers, as calendar events do.
