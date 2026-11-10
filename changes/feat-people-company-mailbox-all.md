### Added

- **"This is the company's mailbox" can close every pair on the address at once.** `people.decideLink` with
  `company: { all: true }` turns down every open proposal on the same shared mailbox in one decision, gives the
  address to the one organization, and lists the proposals it closed as `closed` in the decided proposal's result.
  Without `all` it closes only the pair asked about, as before ([ARCHITECTURE.md](../docs/dev/ARCHITECTURE.md)).
