# @wirecat/cli-core-sqlite

SQLite 3.53.4, built from the official amalgamation for the places `@wirecat/cli-core` loads it
when the runtime's own SQLite cannot hold its message store: Bun on macOS (13.0 and later, arm64 and
x86_64), and a Linux distribution's Node (x64 and arm64, glibc 2.28+ or musl).

Next to each library sits [sqlite-vec](https://github.com/asg017/sqlite-vec) 0.1.9 as a loadable extension
(`vec0`), the store's vector index, built from its release amalgamation. Every runtime Core supports loads it:
the same targets, plus Windows x64 (`vec0.dll` only, since Node there has SQLite built in). sqlite-vec is by
Alex Garcia, dual-licensed MIT or Apache-2.0; it is shipped here under Apache-2.0.

`libraryFor()` returns the library for the running platform, or nothing; `extensionFor()` the extension.

Built and published by `.github/workflows/sqlite.yml`; `build.sh` builds one target, `check.sh`
checks a library exports what Node imports, `probe.mjs` that a runtime holds the store on it and loads `vec0`.
