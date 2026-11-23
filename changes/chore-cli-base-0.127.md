### Changed — may break callers

- **A file mirror's guard on mass replacements names the count to allow.** A sync stopped before more than 50
  replacements now says to pass `--allow-replacements <count>` with the count filled in, where its default hint said
  `--replace`; `allowReplacements` already took a count. A CLI that offers neither option and relied on the default
  hint should add `--allow-replacements <count>`. One that keeps its `--replace` switch passes
  `allowReplacements: Number.POSITIVE_INFINITY` and its own `allowReplacements` hint, as before
  ([DOCUMENTS.md](../docs/dev/DOCUMENTS.md#plain-files-both-ways)).
- **Uses `@wirecat/cli-base` 0.127.0**, whose vocabulary has `mirrors`, `conflicts`, `--keep <side>`,
  `--allow-deletions <count>`, `--allow-replacements <count>` and `--repin`: the mirror's conflict commands pass
  `cli-dev lint` with no override for them.
