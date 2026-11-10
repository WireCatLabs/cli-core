### Added

- **`projectActivity` says how busy every project's linked chats were, in one call.** For each of the owner's
  projects: how many chats are linked to it or its child projects (every confirmed link, any purpose, no chat
  limit; `partial` when some child projects were too deep or too many to read), how many of them are muted now, the messages and the owner's own in a window by when they
  were sent, the newest message, and the busiest chats; muted chats are left out of the counts. A page at a time,
  busiest first, optionally only some accounts. The store read under it, `MessagesStore.chatActivityCounts`, reads
  each chat's window once.
- **`PersonDoubt.moves`**: the fix of each doubt as data (`{ op: "unmerge", merge }` or
  `{ op: "unlink", identities }`), one per `fix` command, so an app runs it without parsing a command line.
