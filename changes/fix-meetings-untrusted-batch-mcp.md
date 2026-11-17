### Fixed

- **`meetings batch --format text|markdown` marks other people's text in a scheduled agent's run.** Transcript cues
  and search hit excerpts and titles were printed with no untrusted marks; only JSON carried them. The report a host
  formats with `formatMeetingBatch` now comes marked, so a host needs no change.
- **`callMeetingPassageTool` takes how the host prints a passage in this run.** Pass
  `(result, format) => passageForRun(command, result, format)` as its new last argument, and the `meeting_passage`
  text carries the same marks as `meetings passage` in a scheduled agent's run. Without it the text stays unmarked.
