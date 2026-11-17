### Changed — may break callers

- **The tracker's commands follow the command vocabulary**, so `cli-dev lint` passes a tracker CLI (with cli-base
  0.117.0, which has `issues`, `teams`, `states` and `labels`). Each list narrows by its query, as `deals list` does:
  `issues list team:<id> project:<id> assignee:none state:<id> type:started label:<id>`, and `archived:include` on
  every list, in place of `--team`, `--project`, `--assignee`, `--state`, `--type`, `--label` and `--archived`.
  `type:` repeats for any of several types. `issues task` is `issues assign`: it makes the issue the owner's task
  and changes nothing in the tracker; its `--due` reads times as `tasks --due` does (a day is its end, `3d` works). `issues search --any` is gone.
  See [Trackers](../docs/dev/TRACKER.md#commands).
