### Added

- **A CRM CLI can add comments and tasks to records, and close a task.** A writer whose capabilities name
  `activities: ["comment", "task"]` (either or both) and that implements `createActivity` and `completeActivity` gets
  `activities create <comment|task> --subject deal:12 [--title] [--text] [--due] [--owner]` and
  `activities close <task>`. Each goes through the same guarded path as `deals create`: journaled with an operation id,
  checked against `activities.create` or `activities.close` (allowed by default), and against `crm.assign-others`
  for a task given to another CRM user (`crmAlsoChecks` names it under `--dry-run`). The CRM's answer is stored as a
  sync stores it, so `activities list` shows it at once when the activities setting is on. A CLI that does not set
  `activities` in its capabilities gets no new command. The fake CRM source takes them when its capabilities name
  them, and records them in `activityWrites`.
