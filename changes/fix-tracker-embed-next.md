### Fixed

- **A tracker's `sync --embed` offers to run again while chunks are left without vectors.** One run embeds at most
  600 chunks; past that it answered `left: true` and no next step, so an agent stopped with part of the issues,
  projects and comments missing from `search all` by meaning. It now adds a `tracker.sync` step with `embed: true`
  and the count left, as a CRM CLI's `sync --embed` does.
