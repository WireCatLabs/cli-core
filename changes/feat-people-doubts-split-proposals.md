### Added

- **`PeopleStore.doubts` lists people that may be wrong**, a page at a time, the owner first, each with a plain reason,
  the identities in doubt, the evidence and the owner's commands that would fix it: the owner's person holding an
  identity under another name (spelling and script aside; what the owner linked by hand never counts), test data (the
  contract seed's people, an address at a reserved domain such as `.test` or `example.com`), an identity joined by an
  address that a person of another name has, and one person with different names and no phone or address in common.
  It reads only the people with more than one identity and one pass over identities: about 0.1 s on a store of 150k
  people.
- **An agent's unlink or unmerge waits for the owner.** `PeopleStore.proposeSplit` stores an `identity_split`
  proposal (the identities that leave, all of one person, or a `merge:<to>-<from>`) with its reason;
  `decideSplit` is the owner's alone and carries it out as the owner's own unlink, split or undo of the merge, refused
  with `identity.stale` when the person changed since. `splitProposals` lists them, and the shared review
  (`proposalRegistry`) shows and decides them as kind `identity_split`, owner-only. Proposing an open split again
  renews it after the person changed. A split the owner turned down is not proposed again while its identities stay
  on that person, and `doubts` leaves them out. Removing a CRM contact or erasing an identity deletes the splits that
  name it. No store migration: older builds see the kind as a plain action, and one they approve is never carried
  out (`splitProposals` shows it as `dropped`).
- `SEED_PEOPLE`, `RESERVED_ADDRESS_GLOBS` and `SEED_ID_GLOBS` in the domain, which the contract seed now uses.
