### Added

- **A role list for ties between people and organizations, and role labels in three languages.** `related-to` between
  a person or an organization and another is offered the new `related` list: `colleague`, `adviser`, `investor`,
  `mentor`, `family`, `friend`, plus the owner's own (`knowledge.addRole("related", …)`). It is offered, not enforced:
  any other word is still stored and reads as `custom`. Buying and partnering stay the kinds `customer-of` and
  `partner-of`. Each built-in role of every list carries `labels` (`en`, `ru`, `es`, exported as `ROLE_LABELS`), and
  each row of `listRelations` says in `roleList` which list its role is offered from, so an app shows a picker with
  "add a new role" instead of a text field.
