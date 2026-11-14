### Changed — may break callers

- **Deleting messages and sending rule replies no longer wait for the owner** (owner, 2026-11-14). The built-in
  levels of `messages.delete` and `bot.messages.delete` are now `allow`: `messages delete` deletes without a question
  and without `--allow-dangerous`. `replies.send` is now `allow` (it was `deny`): `serve` sends the replies
  of the rules the owner turned on, and a new rule still starts off. A profile that wants the old behaviour sets
  `messages.delete: ask` or `replies.send: deny`. `mcp.authority` stays `deny`. Over MCP the same levels apply, and
  a write at `ask` goes ahead, as before.
- **`syncAfterInstallCases` adds a shared config with a missing comma between two lines.** The reader mends it, so
  a CLI's sync must exit 0 there; a CLI that reads the file with its own reader fails the new case.

### Added

- **The shared config mends its own slips.** When `~/.config/WireCat/config.json` is not JSON only because of a
  byte-order mark, a comment, a trailing comma or a missing comma between two lines, a reader mends it in place,
  keeping every key, and keeps the old file beside it as `config.json.bak-<time>`. Any other damage is refused with
  its line, column, the text around it (every value hidden) and the likely fix: "add a comma after `"tools": true`
  on line 4". It still never makes a tool read-only.
