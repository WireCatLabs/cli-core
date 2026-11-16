### Added

- **`withReadableDeal(store, viewers, row)`** (`@wirecat/cli-core/crm`) sets a lead's `deal` to `null` when a viewer
  may not read the deal it became.

### Fixed

- **A task or to-do with no due date that arrives done is listed added and done again** in `changes list` and the
  digest. Only a comment, call, e-mail or meeting is taken as done when it was made and listed once; a Bitrix24 task
  with no deadline, closed inside the window, was missing from it.
- **`organizationContext` reads each limited CRM copy's deals with its viewer in the store query**, and the rest
  without it, so more than a page of a colleague's deals no longer leaves the section empty with `hasMore`, nor
  drops the profile's own deals past it.
- **A lead does not name a deal the profile may not read**: `leads list`, `leads show` and `dealContext` with
  `viewing` answer its `deal` as `null`.
