### Changed — may break callers

- **`store.deals.pipeline()` no longer returns `since`**, the UTC day of `window.since`. Read `window.since` (an ISO
  time) instead; memo, the last reader, stopped using it in cli-memo#862.
