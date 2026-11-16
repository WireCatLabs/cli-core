### Changed — may break callers

- **`config set crm.<provider>:<account>.self` is refused** (`crm.self-from-sync`, also from
  `parseCrmSettingValue`). Only a sync records whose copy it is; `config unset` still gives the copy to the next
  sign-in's sync. A typed id could name the CRM's administrator, and offline reads of the copy by its owner's rule
  (`search all` of another account, memo) then showed the whole copy.

### Fixed

- **`changes list` and its `--format report` digest run on Node 22.16.** Their SQL numbered its values (`?13`) and
  bound them from a list, which node:sqlite before Node 22.23 refuses ("column index out of range"); each value is
  now a plain `?` bound in order. The old-Node CI job runs `scripts/node22-crm-changes.mjs` on 22.16.0.
- **`changes list` lists an activity that arrives done with no due date once**, as `activity_added`: an amoCRM or
  Bitrix24 note or logged call was also listed as `activity_done` at the same time. Such an activity's `done_at` is
  now when it was made. Rows synced before keep both lines.

### Security

- **Business contexts and relationships follow the copy's viewer rule.** `organizationContext`,
  `canonicalPersonContext` and `dealContext` take `viewing` (one `CrmViewing` per CRM account, from `crmViewerOf`):
  a deal or lead the profile may not read is not listed or named, `dealContext` of one is `not_found`, and each
  rule's note goes to `coverage.notRead`. `listRelations` takes `viewers` (`CopyViewer[]`) and leaves out, in its
  query, every relationship with a deal or lead end a viewer may not read, so a caller titling relationship ends never
  sees one. Without the options nothing changes.
