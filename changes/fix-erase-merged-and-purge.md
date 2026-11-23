### Fixed

- **Removing an account no longer erases a person its import was merged with.** A person the owner merged with an
  imported one now stays when the account goes, and a person that cannot go no longer makes the whole removal fail.
- **Deleting a person also deletes the people merged into them earlier**, so their name, aliases and tags do not come
  back as a new person. `PersonErasure` lists them in `merged`.
- **The owner's notes about a person or an organization go with them** and are listed in the plan, instead of
  blocking the delete. Another table's row that hangs on a pointing row still blocks it.
- **Removing an account takes the relationships it reported**, and every row that points at its deals and leads
  (a fact, a note, a tag), not only a fixed list of tables.
