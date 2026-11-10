### Changed — may break callers

- **Taking identities off a person can name that person, and is refused when they sit on someone else.**
  `people.unlinkIdentity(ref, { from })` and `people.proposeSplit({ identities, from })` take the uid of the person the
  identities leave; `people.split(uid, …)` checks its `uid` the same way. An identity on another person is refused with
  `validation_error`, reason `identity.held-elsewhere`, `param: "from"` and `reference: "person:<uid>"` of whoever holds
  it, and the message names them, so nothing moves. Before, a script that meant to take a colleague's mailbox off the
  owner's card took it off the colleague. `split`'s refusal for an identity of another person is now this one (it said
  "is not an identity of person:<n>").
- **A doubt's unlink names the person it takes the identities from.** `people.doubts()` gives each `unlink` move a
  `from` (`person:<uid>`), and its `fix` command ends in `--from person:<uid>`, which memo's `people unlink` needs.
