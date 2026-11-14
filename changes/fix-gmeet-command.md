### Fixed

- **The `google-meet` provider names its tool `gmeet`.** The Google Meet CLI is published as `@wirecat/gmeet-cli`
  with the command `gmeet`; 0.655.0 named it `meet`, so a hint that opens a Meet meeting pointed at a command that
  does not exist.
- **`access.denied` and `item.not-found` are registered reasons.** `./google`'s `googleError` raises them for a 403
  and a 404; they were missing from the reason registry, so a CLI that lists its reasons from cli-core did not
  declare them.
