### Added

- **`knowledge.eraseOrganization` deletes an organization and what memo knows of it alone.** The tags, links,
  aliases and mentions that name it go, and so does which identities it held. A deal, lead, project, account, fact or
  note that names it stays and loses the name. `apply: false` answers what would go and changes nothing. Owner only;
  refused for one of the owner's own companies (`organization.own`), and while an invoice, order, subscription or a
  row it wrote still names it (`organization.erase-blocked`). It shares `ErasePlan` with `people.erase`: both read
  the store's own pointers and foreign keys, so the plan shown and the delete run read one list.

### Fixed

- **Removing an import's account now takes the organizations only its records made**, as it does for people. One
  that another source, a deal or the owner still names stays.
