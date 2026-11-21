### Added

- **`threadReplies`: `messages sync` saves the thread replies a chat's history leaves out.** Slack's channel history
  holds top-level messages only, so a new reply to an old thread never reached the store. A messenger adapter may
  now offer `threadReplies(chatId, { since })`: after a chat's history pages the sync asks it for the replies sent
  since its last read of them (`since` is left out on the first), and saves them without marking a stretch of the
  history held, so the history's resume point does not move. `messages sync --all` no longer passes such a chat as
  already held to its newest message, since a reply moves neither the newest stored message nor, on every
  messenger, the chat's last message.
