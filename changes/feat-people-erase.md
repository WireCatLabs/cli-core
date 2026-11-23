### Added

- **`people.erase` deletes a person and what memo knows of them alone.** Their identities go, with the tags, links,
  aliases, mentions and involvements that name them. A fact, note, task or import record that names them stays and
  loses the name. A message, mail or meeting belongs to its source: the sender stays as an identity with no person,
  and the next sync or people scan gives it one again. `apply: false` answers what would go and changes nothing.
  Owner only; refused for the owner's own person (`person.owner`), and while an invoice, order, subscription or a row
  the person wrote still names them (`person.erase-blocked`).

### Fixed

- **Removing an import's account now takes the people only its records made.** Its e-mail and phone identities were
  never referenced by anything, so the purge kept them and the person stayed. A person the owner tagged, linked or
  gave a task to, or one another source or a message also names, still stays.
