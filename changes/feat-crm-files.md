### Added

- **CRM client files in the store (store version 68).** `crm_files` keeps each downloaded file of a deal, lead,
  contact or company with its owner record, the record's assignee at download, the local path and the extracted
  text, in its own word index `crm_file_words`; never a download link. `store.crmFiles` saves, lists and finds them,
  a limited profile only those of records assigned to its user. `store rebuild`, `store recover` and the
  integrity check know the new index; an account's purge removes its rows.
- **`CrmSource.files(owner)`** (`@wirecat/cli-core/crm`): one record's files read live with the record's assignee,
  each with an `open()` that keeps the tokened link inside the adapter; `crmFileId` and `parseCrmFileId` for the opaque
  file id.
- **`withoutFileLinks(body)`** replaces every tokened file link in a CRM answer with `[link removed]`, for `api call`. `crmValuesOf` applies it to every custom value, so a file field's
  link reaches neither the store nor an answer.
- **`fakeCrmSource({ files })`** and `FAKE_FILE_TOKEN` in `@wirecat/cli-core/crm/testing`.

### Changed — may break callers

- **The daily limit on other people's records covers deals and leads.** `foreignContacts(...).spend` takes any CRM
  kind and a record with only `externalId` and `assignee`; a deal or lead is the sign-in's own when assigned to its
  user. The refusal says "records that are not yours" instead of "contacts and companies".
