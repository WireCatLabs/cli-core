### Added

- **Hints, help and errors name `wcat` and `files`, not `memo`.** memo became `wcat` (`@wirecat/wirecat`), and its
  local files commands moved to the files CLI (`@wirecat/files-cli`). Every CLI's "Works with" screen lists `wcat
  context <person>` and `files`, and a hint such as "mail is searched by wcat: install @wirecat/wirecat, then `wcat
  search mail …`" replaces the `memo` one. `WIRECAT_TOOLS` has the entries `wcat` and `files` in place of `memo`, and a
  new `program` field (`wcat-wirecat`): the first-run tool list checks that program, since every WireCat tool installs
  a `wcat` launcher. `WCAT_SCENARIOS` replaces `MEMO_SCENARIOS`, which stays as a deprecated alias. A CLI's
  `contracts/help.snap` and `docs/commands.md` change at its next bump. Watch for: the shared `search` description
  changed, and `customizeSharedCommand` refuses an override whose "before" text no longer matches, so zoom-cli fails
  at start on this cli-core until its `src/contract-overrides.ts` says the new text (memo's override goes with phase 4
  of the split).
- **A send never takes a file from memo's old `cli-memo` folders**, as it already refuses every other WireCat tool's
  folders, and store recovery counts `wcat-*` timers as WireCat's.
