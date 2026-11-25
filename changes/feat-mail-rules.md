### Added

- **Mail sorting rules (store version 77).** `store.mail.sorting` keeps the owner's and the program's rules over mail:
  `add` (with `dryRun`), `rules`, `remove`, `undo`, `reset` and `scopes`, all experimental. A rule names its scope,
  one mail, a List-Id, a subject pattern, an address or a registrable domain, and says whether it sorts past mail too
  (`applyTo: "all"`) or only mail dated from now on (`"new"`). The first scope that has a rule wins, in that order, then
  the header classifier; within a scope the owner's rule beats the program's and the newest wins, and a domain rule may
  beat the address rules (`overAddresses`). A rule sets the mail type, makes the sender a bot or a person through
  `moveToBot` and `moveToPerson`, or files the sender under an organization. An email a rule typed has `typeSignal`
  `rule:<id>`. A domain rule on a free-mail or throwaway domain is the owner's only and is set only with the `confirm`
  of a dry run that shows how many addresses and emails it touches. Removing or undoing a rule types its mail again and
  moves its senders back. Not the storage `store.mail.rules`.
