### Changed — may break callers

- **A messenger's `account sessions` is now `account devices`, with no alias.** The group lists the
  devices and apps where the messenger account is signed in. Its old name read like `session`, the profiles on this
  computer. Telegram, WhatsApp and MAX call these "devices" in their apps too. `account sessions list` is now
  `account devices list`, and `account sessions end --others` is now `account devices end --others`. The old words
  are not a command any more, so a script that types them stops with a usage error. The MCP tools follow the new
  paths.
- **What breaks for callers:**
  - The permission keys are `account.devices`, `account.devices.list` and `account.devices.end`.
    `account.devices.end` asks by default, as `account.sessions.end` did.
  - A profile that saved an `account.sessions…` key no longer runs: like any key no command checks, it is refused,
    and the message names the new key to rename it to. `<tool> config unset permissions.account.sessions.end`
    removes it, or move its level to `permissions.account.devices.end`.
  - A pinned MCP catalogue, a help snapshot or a parity row that lists `account sessions` changes on the next
    cli-core bump.
  - Unchanged: the answers keep their entities, `account_session` and `ended_account_sessions`, with the `sessions`
    field. The adapter methods `sessions()` and `endOtherSessions()` keep their names, so no messenger adapter
    changes. Nothing in the store changes, so this ships in a minor.
