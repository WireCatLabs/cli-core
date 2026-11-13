### Added

- **Stage tasks open on every stage a deal or lead entered, also one passed between two syncs.** A CRM source may
  give `stageHistory(kind, since, after, context)`: the CRM's own record of each entry into a stage. While the
  account has `stage-tasks` rules for the kind, `sync` reads it after the last entry it read (the first read from
  when stage tasks last ran), keeps the entries on kept deals and leads as `crm.stage-entry` records, and the stage
  tasks open from them: a deal moved A→B→C between two syncs gets the tasks of B and C. A source without it keeps
  comparing the copy between syncs. A failed read is the issue `crm.stage-history-failed`; the deals and leads are
  still synced. The funnel still counts the copy's own stage changes.
