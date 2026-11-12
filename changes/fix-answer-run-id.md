### Fixed

- **An answer's `meta.run_id` names the run that did the work.** A command that opens several runs, like
  `messages sync` (the fetch, then the task rules, then the mention count), named the last one, which logged nothing:
  `runs show <run_id>` found no requests and no `sync.progress`. Now the command's first run names the answer, and a
  named side run (`sync tasks`) never does.
