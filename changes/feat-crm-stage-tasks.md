### Added

- **A deal or lead entering a stage opens a local task.** The owner's setting `crm.<provider>:<account>.stage-tasks`
  maps a stage to a task, `{"<stage id>": {"title": "…", "due_days": 2}}`, a lead's stage as `lead:<stage id>`. After
  each CRM `sync`, every move into such a stage since the last sync opens one task, due that many days later, whose
  description names the deal, the stage and the responsible user. A move counts once: a dismissed task never comes
  back, and entering the stage again opens a new one. Moves made before the setting was first saved, and a new row's
  first stage, open none. The sync answer's `stage_tasks` says how many it opened, a deal's context lists them, and
  an agent cannot change the setting. See
  [KNOWLEDGE.md, "Relationships a source reports"](../docs/dev/KNOWLEDGE.md#relationships-a-source-reports).
- **`NewTask.title` and `description`.** A rule that knows what to do gives its task a title and a description.
