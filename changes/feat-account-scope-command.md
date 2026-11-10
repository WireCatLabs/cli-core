### Added

- **The owner sets an account's scope, personal or work, and pins or clears a chat's.** `setAccountScope` and
  `setChatScope` (from `/services`) take an account as `--source` names it (`bitrix24:acme.bitrix24.ru`, `tg:work`),
  refuse a run locked to a group, and are for an owner-only command (`grantsAuthority`). An account's change moves
  what search copied of its old scope: its conversation pieces and involvements, its other search pieces, and the word
  indexes of its documents, mail and calendar events, which are built again on the next search. A chat with its own
  scope keeps it; memories and facts keep the scope they were written with. A chat's change is recorded in its
  history as the owner's. The store methods are `accounts.setScope` and `chats.setChatScope`.
- **A CLI chooses the scope its new accounts start as.** `accounts.saveAccount(key, { name, scope: "work" })` makes a
  new account work; an account already stored keeps its scope, so a sync never undoes the owner's choice. A `scope`
  in the `AccountKey` itself still overwrites the stored one on every save.
- **Each member of an account group carries its account's `scope`**, so a groups view shows and switches it in place.
