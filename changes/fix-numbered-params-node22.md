### Fixed

- **Pruning old decision requests works on Node 22.16.** The query bound a numbered `?1`, which Node 22.16's
  `node:sqlite` rejects with "column index out of range". The old-Node CI job now runs a prune.
