### Fixed

- **`runScopeCases` gives a recorded command 15 s to end against the answering fake**, in place of 2 s. The case
  checks that the command ends inside core's run, not how fast; a whole sync on a loaded machine took over 2 s, so a
  CLI's local `bin/release` failed on it while CI passed. The silent case keeps its 2 s after `--timeout`.
