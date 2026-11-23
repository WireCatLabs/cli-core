### Added

- **`unreadChats`, an optional messenger port for `inbox` and `review`.** A messenger whose chat list carries no
  unread counts or last message times, because each costs a request (Slack), answers them here; `inbox`, `inbox --new`
  and `review` use it when present, and every other command keeps the cheap `chats`. `hasMore` marks the answer
  partial.
