### Added

- `store.people.list({ query, all, sort, limit, offset })`: people a page at a time, with `total` and `hidden`, each
  with a cleaned `displayName` (no wrapping quotes or spaces; a name with no letter or digit shows the username, phone
  or email), the first username, phone and email, and `ties`. By default it lists only people with a tie to the
  owner: a one-to-one chat, a group of at most 10 (`SMALL_GROUP_MEMBERS`; a group of unknown size counts as large),
  mail the owner wrote to them, a meeting or calendar entry, a CRM, or the address book. The owner, people added by
  hand and anyone assigned a task are always listed; `all` adds the rest. Ties are read on every call; on a synthetic
  store of 51,000 identities a first page takes about 100 ms
  ([cli-testing `performance/people/ties`](https://github.com/WireCatLabs/cli-testing/tree/main/performance/people/ties)).
- `store.people.similar(name, { limit })`: people whose name has a word starting with each typed word, in any order,
  the same name first (`sameName`), for a form that adds a person.
- `store.people.saveAddressBook`: `contacts sync` now marks who is in the account's address book, and unmarks who left
  it (`account_identities.address_book`, store version 61). Sync contacts once after upgrading: until then nobody has
  the address-book tie.
- The people matcher proposes two people with one name (case, quotes, punctuation and word order set aside) who share
  a phone, an address, a chat or a company's mail domain, as an `identity_link` with signal `name`. It never joins
  them; a free mailbox's domain (gmail.com) or a role address (`info@`) is no trace, and a name more than six people
  have is skipped.
- `store.people.ties(refs)`: why each person is shown, as the list gives it.
- `displayName` and `nameKey` from the package root.
- `schedule … --at 'mon 09:00'`: a weekday before the time makes a weekly run (systemd
  `OnCalendar=Mon *-*-* 09:00:00`, launchd `Weekday`, Task Scheduler's weekly trigger). With `--every` it is refused.

### Changed — may break callers

- `IDENTITY_LINK_SIGNALS` gains `name`, and a schedule's `When` gains `{ weekly, on }`: code that switches over every
  signal or every `When` needs the new case. `AccountPeople` and `PeopleStore` gain `saveAddressBook`, `list`,
  `similar` and `ties`, so a hand-written fake of either needs them.
