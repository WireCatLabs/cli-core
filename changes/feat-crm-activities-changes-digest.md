### Added

- **`changes list [query]`** answers what changed in the CRM copy in a window, newest first: deals and leads made,
  moved, won, lost and given another owner, activities added and done, and contacts added. `at:` sets the window (the
  last day when left out), `change:`, `owner:` and `pipeline:` filter it, `--limit` and `--cursor` page it over the
  same window, `--format csv` prints it, and `meta` names the time zone and the window. A won or lost deal is dated by
  the CRM's own stage history when it has one (`exact: true`).
- **`changes list --format report`** prints a CRM morning digest document: deals won and lost first, then overdue CRM
  tasks, those due today, stage moves, new deals, new owners, new contacts and the tasks the stage rules opened, with
  "and N more" counted in full. It names a failed or stale sync. Run by a schedule, each digest starts where the last
  one ended, so a late or missed run loses nothing and no deal shows twice. Scheduled with `schedule command`, it is
  rendered and delivered like an agent's digest.
- **`activities list [query]`** in a CLI that copies the CRM's activities: open ones overdue first, then by due time,
  then undated; `status:`, `due:`, `overdue:`, `kind:`, `deal:`, `lead:`, `person:`, `organization:` and `owner:`.
  With the activities setting off it says so in `missing`.
- **A `command` schedule whose output is a report document is rendered and delivered as a report**, with a `crm`
  section kind in the morning digest. Its text is the store's data: a title such as `follow_up` is kept as it is.
- A profile that may read only its own part of a CRM copy sees in these commands only its own deals and leads, the
  activities on them and the contacts linked to them.
