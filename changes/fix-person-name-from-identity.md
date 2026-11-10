### Changed — may break callers

- **A person with no readable name of their own is shown by an account's name before its username.** `people.list`
  gave such a person `displayName` `@Xorlov` although their Telegram account is named «Ярослав Орлов» (a person left
  with no name after a split, for one). The first readable account name now comes first, then the username, phone and
  email as before; `displayName(name, { name })` takes it. The shown name also drives the sort by name and the
  automated and company checks, so such a person may move in the list or between kinds.
