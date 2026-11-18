### Added

- **The `api` group checks a key by a field's value, as WordPress publishes by `status: "publish"`.** A manifest
  permission with `values` (cli-base's `permissions.valueKeys`) applies when the call's JSON body or its query holds
  one of those values: `{ key: "posts.publish", values: { status: ["publish", "future"] } }` asks for
  `posts.publish` before `api post-wp-v2-posts --body '{"status":"publish"}'` and lets a draft through. Both places
  count, because WordPress reads the same parameter from either. So a profile that denies publishing also stops an
  agent that publishes through the raw `api` group. `--dry-run` and discovery show the key with
  `with status publish or future`.

### Changed — may break callers

- **cli-core needs `@wirecat/cli-base` 0.118.0**, which carries the manifest's `values` and WordPress's
  `wpJsonToOpenApi`. A CLI that pins an older cli-base raises it with this cli-core.
