### Fixed

- **`search conversations` no longer spends seconds working out which chats are behind.** The check behind the
  "changed since the last build" hint read every chunk of the store once per built chat, because SQLite chose the
  wrong table to start from. It now reads only the chat's own conversations. On a store with about 950,000 messages a
  warm search went from about 12 s to about 3 s. `conversations status` and `conversations embed` use the same query
  and are faster too.
