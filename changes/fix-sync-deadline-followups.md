### Added

- **Enrichment takes the run's `deadline`** (`EnrichOptions.deadline`, and `batchMs` for the expected time of one
  batch, 30 s by default). A batch starts only while it is expected to end before the deadline less its margin, so a
  paid request is not cut and sent again at every sync. A batch cut all the same stops the run with the new
  `enrichment.deadline` reason, not `failed`. `embedNotes` and `embedMail` pass their `deadline` on. See
  [the enrichment section](../docs/search/ai-providers.md).

### Fixed

- **A documents sync asks its budget before each picture download**, as it does before a file read, so picture
  search no longer runs a sync past its deadline. A refused download leaves the file for the next sync. See
  [Walks over several syncs](../docs/dev/DOCUMENTS.md#walks-over-several-syncs).
- **An embed whose last batch ends as the run is cut answers that it is done**, not `left: true` with
  `remaining: 0`.
- **`remaining` after an embed stop counts only the chunks the embed would still be given.** It counted chunks of
  gone notes and enrichments too, so it never reached 0.
