### Changed — experimental

- **A messenger's profiles are listed by `session list`, and `account list` is gone (WC-CMD-8, WC-ACCT-12).** The
  shared messenger `account` group no longer has `list`, with no alias. `session list` answers the same rows. The
  shared `session` contract (`sharedCommandTemplate(app, "session")`) now has `status` and `list` beside `start` and
  `end`, so a messenger CLI mounts `messengerSessionCommands(messenger)` in its own `session` group, or its session
  shell no longer matches the contract. The parity manifest lists `session list` and `session status` in tg, max and
  wa, and the first help screen points at `<tool> session list`. Like the rest of the `session` group, `session list`
  is not an MCP tool: the all-profiles MCP server already names every profile, and whether it is signed in, in each
  tool's `profile` field. The commands a CLI mounts are not part of the stable API: `accountCommand` and
  `messengerSessionCommands` keep their signatures, so this ships in a minor.
- **slk loses its duplicate `account list`** on its next cli-core bump: it mounts the shared `account` group, and its
  own `session list` stays. Every CLI with a `session list` (drive, gcal, zm, mail, b24, slk and others) gains the
  line `<tool> session list    your profiles and their logged-in accounts` on its first help screen, so its
  `contracts/help.snap` changes on that bump.
