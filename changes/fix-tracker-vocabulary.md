### Changed — may break callers

- **The tracker writes use the family's words.** `issues comment <issue> --body <text>` is now
  `issues comments create <issue> --text <text>`, and its permission key `issues.comment` is now
  `issues.comments.create` (`TRACKER_WRITE_KEYS`): a saved `issues.comment` is refused and names the new key, and
  `trackerAlsoChecks` finds the write by its path. On `issues create|update`, `--state <state>` is now
  `--status <state>`, the family's flag for the state to put a thing in, and `--parent <issue>` is now `--parent <id>`,
  with the same values. `--priority <n>` takes the family's priority, as `tasks` do: low, medium, high, critical
  (or the tracker's urgent) and none, a score from 0.0 to 1.0, or the old 0 urgent … 4 low, written on the tracker's
  scale (critical 1, high 2, medium 3, low 4, none 0). A bare `2` was the tracker's high and is now the family's
  medium. An issue's answer has `priority_label` beside the tracker's `priority`. No tracker CLI with these commands
  is published yet; linear-cli moves its tests and README with its next bump
  ([TRACKER.md](../docs/dev/TRACKER.md#writes), #3237).
