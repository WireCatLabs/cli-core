### Fixed

- A tracker's combined `sync` that cannot reach the tracker and has no documents folder chosen fails as a tracker-only
  `sync` does (for example `authentication_error` before sign-in) instead of a partial answer that exits 0.
