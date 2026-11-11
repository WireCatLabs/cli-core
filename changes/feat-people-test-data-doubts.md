### Added

- **Test data is hidden from people lists.** A person whose every identity has a seed id or an address at a reserved
  domain (`example.com`, `.test`, `.invalid` and the like) is of the new kind `test`, which every kind and `all` leave
  out; `people.list({ kind: "test" })` lists them. `people.markTestData` hides a person the owner calls test data, and
  `people.keep` on a hidden person brings them back as a real contact. Both are kept in the store, so every computer
  sees them. See [ARCHITECTURE.md, "Who is shown"](../docs/dev/ARCHITECTURE.md).
- **Every phone and address of a CRM contact.** `CrmPerson.phones` and `emails`, and `PersonFacts.phones` and
  `emails`, keep all of them on the identity; a linked identity gives them as `phones` and `emails`, its `phone` and
  `email` among them.

### Changed — may break callers

- **`PersonKind` has a sixth kind, `test`.** A caller that keeps a record of every kind adds it; `people.list` and
  `people.counts` give it, and `kind: "all"` leaves it out.

- **A doubt about test data asks only when unsure.** A seed name alone is a `test-data` doubt with the move
  `{ op: "test-data", person }` (`people links resolve <who> test`), and `keep` now answers it as a real contact
  instead of refusing it with `person.test-data`, which is no longer raised. A test identity on a person who holds a real one is a doubt with an
  unlink. Sure test data is no longer a doubt.
- **A short form of a name, or a name that repeats the mailbox, is no second name.** Ярик and Ярослав, Bob and Robert,
  and a Drive or mail identity named after its own address no longer make a `shared-address` or `mixed-names` doubt.
