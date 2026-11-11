### Fixed

- **`messages sync --all` reports progress while a chat is read.** Its progress line on stderr came only when a chat was finished, so a chat of many paced pages showed the same count for minutes, and a desktop app's bar stood still at the first chat. Every page now updates `fetched`, with the chat totals of `--all`.
