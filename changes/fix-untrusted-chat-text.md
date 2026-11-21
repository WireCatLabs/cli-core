### Fixed

- **Chat titles, descriptions and a contact's own text reach a scheduled agent marked as untrusted.** Other people
  set a group's title and description, a forum topic's title and their own contact description, yet only messages
  were marked. In a scheduled agent's run, `chats list`, `chats show`, `chats events`, `topics list`, `topics show`,
  `search topics`, `contacts list` and `contacts show` now put `title`, `description` and a contact's shared
  `chats.title` between the run's markers, as `messages list` marks a message's text. Outside such a run nothing
  changes.
