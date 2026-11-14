### Added

- **Search by meaning for any host of stored meetings, from cli-core.** `addMeetingCombinedSearchCommand` in
  `@wirecat/cli-core/cli` mounts `search meetings`: words by default, and words and meaning ranked together with
  `--model <model>`, which first splits new transcripts and builds the missing vectors. A hit says how it was found
  (`by`), its similarity (`score`) and the passage meaning matched, and marks `excerpt`, the passage and the title
  untrusted. `addMeetingEmbeddingCommand` mounts `meetings embed`: a preview, and `--yes` splits every transcript and builds one batch of the missing
  vectors; a rerun builds the next.
  Without `--model` it uses the `models` command's default local text model, so the transcripts stay on this
  computer; `--base-url` sends passages to a remote service only when given, and `--offline` refuses it. Both run over
  `meetingMeaning(store, accountId)` in `@wirecat/cli-core/services`. These moved from zoom-cli, which can mount them
  in place of its own copies; pbx and beeline mount them for calls.
- `meeting_hit` takes the optional `by`, `score` and `passage` of a search by meaning.
