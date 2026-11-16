### Added

- **`changes list [query]`** answers what changed in the CRM copy in a window, newest first: deals and leads made,
  moved, won, lost and given another owner, activities added and done, and contacts added. `at:` sets the window (the
  last day when left out), `change:`, `owner:` and `pipeline:` filter it; `--limit`, `--page` and `--format csv` page
  and print it, and `meta` names the time zone and the window.
- **`changes list --format report`** prints the window as a CRM morning digest document: overdue CRM tasks first, then
  those due today, deals won and lost, stage moves, new deals, new owners, new contacts and the tasks the stage rules
  opened. Scheduled with `schedule command`, it is rendered and delivered like an agent's digest.
- **`activities list [query]`** in a CLI that copies the CRM's activities: open ones by due time, then the rest;
  `status:`, `due:`, `overdue:true`, `kind:`, `deal:`, `lead:`, `person:`, `organization:` and `owner:`. With the
  activities setting off it says so in `missing`.
- **A `command` schedule whose output is a report document is rendered and delivered as a report**, with a `crm`
  section kind in the morning digest.
