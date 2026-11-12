### Changed — may break callers

- **cli-core needs `@wirecat/cli-base` 0.98.0 or later (peer `>=0.98.0 <1.0.0`).** cli-core's types import
  `ListResult` from `@wirecat/cli-base/standards`, which cli-base exports only from 0.97.0 on: a CLI on an older
  cli-base installed without a warning and got `any` for every list result. And `commands --json` now writes
  `"origin": "cli-core"`, which a cli-base reader below 0.98.0 refuses. Bump cli-base with this cli-core.
