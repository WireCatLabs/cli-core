### Added

- **`@wirecat/cli-core-sqlite` 1.2.0 is built as one package per platform.** Its SQLite and sqlite-vec libraries
  move into six optional packages (`@wirecat/cli-core-sqlite-darwin`, `-linux-x64-gnu`, `-linux-arm64-gnu`,
  `-linux-x64-musl`, `-linux-arm64-musl`, `-win32-x64`), and npm, pnpm and Bun install only the one for the
  machine, by `os`, `cpu` and `libc`. Once cli-core depends on 1.2.0, an install is about 9 MB smaller on Linux,
  7.5 MB on macOS and 11 MB on Windows; until then nothing changes for a cli-core install. `libraryFor()` and
  `extensionFor()` answer as before, and a missing library gives the same error. An install with `--omit=optional`
  now has no library ([the package](../packages/sqlite/README.md)).
