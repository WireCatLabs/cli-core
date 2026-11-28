### Fixed

- **A fresh install is about 9 MB smaller: it downloads SQLite only for the system it runs on.**
  `@wirecat/cli-core-sqlite` 1.2.0 keeps each system's library in its own package (`-darwin`, `-linux-x64-gnu`,
  `-linux-arm64-gnu`, `-linux-x64-musl`, `-linux-arm64-musl`, `-win32-x64`), and the package manager installs the
  one that matches. The SQLite version and the vector extension are the same as in 1.1.0.
