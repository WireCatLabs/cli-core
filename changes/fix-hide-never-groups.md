### Fixed

- **A messenger's `never` hides ten more commands, and a group left empty.** `messages forward`, `contacts block`
  and `unblock`, `chats links show` and `reset`, `chats requests list`, `confirm` and `reject`, and `chats admins add`
  and `remove` now refuse before connecting when their one method is in `lacks` or `never`, and `never` hides them
  from help, `commands` and MCP. A group whose every command is hidden, such as `account sessions` or `chats folders`,
  is hidden too, so a messenger can put those methods in `never` instead of `lacks`.
- **A server search no longer erases what the store knew about a message.** A hit is a partial copy: saved over a
  held message, it now adds to its provider metadata instead of replacing it, so a Slack thread root found by
  `search.messages` keeps the reply count a sync saved. A fetch from history still replaces the metadata.
