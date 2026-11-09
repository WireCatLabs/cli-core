### Added

- **A records import reports its relationships as links of its account.** A deal's or lead's people, a contract's
  parties, a person's `member-of` and an organization's `customer-of` and `partner-of` go through
  `relations.syncReported` per chunk, so a re-import keeps them, a changed role adds a link and withdraws the old one,
  a delete withdraws them, `records map` moves them with the entity, and rejecting a proposed contract withdraws its
  parties at once. A role comes only from its list: any other word is kept on a link without a role, in the list
  `metadata.source_role`, and named in the receipt's new `notices` (`relationship.role-unlisted`). A person's
  `fields.position` is `metadata.position`, never the role. The receipt adds `relationships` (`added`, `kept`,
  `restored`, `withdrawn`, `proposed`, `skippedOwnerRejected`), each link counted once per run, and a relationship's
  issue is an error coded `relationship.*`, naming its `record` when that record came in an earlier batch. The
  links' `source` is `import:<provider>`, so an import and a CRM sync on the same account keep each other's.
- **A contract may be related to a person or an organization,** with the roles `customer`, `supplier`, `signatory`
  and `guarantor` (`CONTRACT_ROLES`), a `contract` list the owner may add to like the others.
