### Added

- **A role list for ties between people and organizations, and role labels in three languages.** `related-to` between
  a person or an organization and another takes its role from the new `related` list: `colleague`, `client`,
  `supplier`, `partner`, `adviser`, `investor`, `family`, `friend`, plus the owner's own (`knowledge.addRole`). Each
  built-in role of every list carries `labels` (`en`, `ru`, `es`, also exported as `ROLE_LABELS`), and each row of
  `listRelations` says in `roleList` which list its role comes from, so an app offers a picker instead of free text.

### Changed — may break callers

- **A free-text role on `related-to` between people and organizations is refused** (`relationship.role-unknown`).
  A role stored before stays and reads as `custom`; a new one comes from the `related` list or is added to it first.
