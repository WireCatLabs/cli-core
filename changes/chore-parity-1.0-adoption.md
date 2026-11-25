### Fixed

- **The CLIs are on the parity known-broken list until 2026-12-02.** Each adopts cli-core 1.0 on its `release/1.0`
  branch, in a draft pull request, and its main stays on 0.x until the 1.0.0 batch. Without the list, every pull
  request and release from main failed parity on the CLIs' main.
