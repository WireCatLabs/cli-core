### Added

- **The owner can say a person in doubt is right: `people.keep(person, "owner")`.** The identities in doubt stop being
  listed by `people.doubts()` until one of them moves; an identity that joins later is in doubt again. It is recorded
  as a split the owner turned down, so an agent's split of them is refused (`identity.kept-together`) and an open one
  is turned down. An agent is refused with `identity.owner-only`, a person with nothing in doubt with
  `person.no-doubt`, one in doubt only as test data with `person.test-data`, an unknown one with `person.unknown`. The
  answer is `{ person: "person:<uid>", kept: ["<provider>:<id>", …] }`.
- **A person's record carries `displayName`**, the name `people.list` shows for them: their own, else the first readable
  account name, a username, phone or address. `people.personOf()` and `people.personByUid()` return it.

### Fixed

- **`people.doubts()` no longer lists a person the owner linked by hand under mixed names.** A link moves
  only the identities of the person who joins, so the ones already there kept a rule's method and came back as a doubt.
  An identity on the person when the owner linked into it no longer counts as a different name; one that joins later
  is still checked. A shared address and the owner's own person are checked as before.
- **Store version 66: a person with no name of their own has their kind and name order worked out again when an
  account's name changes.** The migration also clears the stored kind of every person with no name of their own once.
  Triggers only otherwise; `minCompatible` stays 56.

### Changed — may break callers

- **`PeopleStore` has a new method, `keep`.** A store implemented outside cli-core must add it.
