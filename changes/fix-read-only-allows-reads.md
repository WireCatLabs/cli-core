### Fixed

- **The read-only lock lets server search and fetches through.** `<PREFIX>_READ_ONLY` promises "can read and sync but
  never send", yet it refused every key the send guard checks, reads included: `search messages --backend server`
  failed with `permission_error`, and the default `--backend both` dropped the server without a word. The keys that
  only read from the messenger or work locally (`messages.server-search`, `messages.sync-first`, the stats syncs,
  `conversations.embeddings`, `conversations.links`, `attachments.extract`, `store.gaps.repair`) now pass the lock, as
  they already passed a flood hold. The profile's permission level still applies to each. Found by an agent test in
  which tg under `TG_READ_ONLY` answered 6 of 10 questions and a Telegram MCP server 9
  (tg-cli [#874](https://github.com/WireCatLabs/tg-cli/issues/874)).
