### Changed — may break callers

- **cli-core needs `@wirecat/cli-base` 0.97.0 or later (peer `>=0.97.0 <1.0.0`).** cli-core's types import
  `ListResult` from `@wirecat/cli-base/standards`, which cli-base exports from 0.97.0 on. A CLI on an older cli-base
  installed without a warning and got `any` for every list result. Bump cli-base with this cli-core.
