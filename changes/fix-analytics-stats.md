### Added

- **`muted:` in the query language.** `muted:true` matches messages in chats the owner muted, until the mute runs
  out; `muted:false` matches every other chat, so `stats messages show 'muted:false date>=30d'` counts only what the
  sync still reads. A messenger that keeps no mute state counts its chats as not muted. `stats messages responses`
  and `stats messages waiting` take it too.
- **`stats tasks show` can count every account at once.** A `Messenger` that sets `accountsOf(command)` gets one answer
  across the accounts it returns, when the command names none: memo uses it so `memo stats tasks show` needs no
  `--source`. The answer lists them in `accounts`, and each chat row's `chat` names its own account. `--chat` and a
  `chat:` naming one chat are then refused, since a chat belongs to one account.
