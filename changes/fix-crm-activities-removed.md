### Fixed

- **A note or task deleted in the CRM leaves the copy.** The sync kept every activity it had once stored. It now marks
  deleted the ones a source's page names in `removed`. A source that lists every activity on each run sets
  `listedAll` on its last page, and then a stored activity it did not list is marked deleted too, when the round was
  read whole and no list was refused. A list that would mark most of ten or more is held with
  `crm.activities-unlisted-held` until `sync --rescan`. `sync` counts them in `activities.removed`
  ([CRM](../docs/dev/CRM.md#activities-changes-and-the-digest)).
