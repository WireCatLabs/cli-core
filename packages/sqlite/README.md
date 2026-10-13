# @wirecat/cli-core-sqlite

SQLite 3.53.4, built from the official amalgamation for the places `@wirecat/cli-core` loads it
when the runtime's own SQLite cannot hold its message store: Bun on macOS (13.0 and later, arm64 and
x86_64), and a Linux distribution's Node (x64 and arm64, glibc 2.28+ or musl).

`libraryFor()` returns the library for the running platform, or nothing.

Built and published by `.github/workflows/sqlite.yml`; `build.sh` builds one library, `check.sh`
checks it exports what Node imports.
