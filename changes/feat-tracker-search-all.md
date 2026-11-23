### Added

- **`search all` finds a tracker's issues, projects and comments.** A new lane, `tracker`, reads every tracker
  account's copy by the words of titles and text, as `issues search` does, beside messages, mail, notes and the rest.
  Hits are `issue` (titled with the key, `ENG-12 Fix login`), `project` and `issue_comment`, with ref
  `tracker:<provider>/<account>/<kind>/<id>`, their title and excerpt untrusted. A provider kind `tracker` joins the
  registry, and `linear` is seeded as one. A CLI that gates `search all` lanes by list keys gates issues and comments
  by `issues.list` and projects by `projects.list`: memo needs that gate in the bump that brings this lane
  ([TRACKER.md](../docs/dev/TRACKER.md#search-all)).
