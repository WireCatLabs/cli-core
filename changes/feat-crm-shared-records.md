### Added

- **`addCrmCommands` mounts `people`, `organizations` and `users` list and show, read live from the CRM.** A CLI passes
  `live: ["person", "organization", "user"]` for what its source reads: `CrmSource.list(kind, query)` and
  `get(kind, id)` for contacts and companies, the existing `users()` for users. `--offline` is refused. Lists take the
  same query language as `deals list` (`name:anna*`, `assigned_to:7`, `created_at>=7d`, a custom field by its code or
  label), `--limit`, `--page`, `--format csv`, and `--json=provider_metadata.<code>`. The answers are the shared
  entities `crm_person`, `crm_organization` and `crm_user` (`crmPersonOf`, `crmOrganizationOf`, `crmUserOf`).
  See [CRM](../docs/dev/CRM.md).
- **`people create|update` and `organizations create|update`** go through the guarded write path of `deals create`:
  the read-only lock, the keys `people.create`, `people.update`, `organizations.create`, `organizations.update`, and
  `crm.assign-others` for another owner, the journal and `operation_id`. The CRM's answer is stored as a sync stores it
  (`createCrmRecord`, `updateCrmRecord`).
- **The daily limit on foreign contacts is shared.** With `CrmSource.isAdmin()`, anyone but the CRM's administrator
  sees phones and e-mails only of their own clients (`assignee` is the sign-in's user, or `CrmSource.ownClients()`
  names them) and at most `DAILY_FOREIGN_CONTACTS` (100) other contacts or companies a UTC day in `show`. The count
  is kept under a file lock, so two runs never both take the last slot (`foreignContacts`).
- **Helpers every CRM adapter needs**, from `@wirecat/cli-core/crm`: `providerCall` (paced calls, reads retried, writes
  retried only on `rate_limited`, a write with no answer `outcome_unknown`, one token refresh on `oauth.expired`),
  `walk` and `crmWindowOf` (the CRM's pages into one answer page with `hasMore`), `conditionsOf` and the custom-field
  query helpers, `crmValuesOf` (custom values with labels), `crmCustomValues` (`--field` pairs), and the JSON
  coercions `text`, `id`, `ids`, `number`, `time`, `epoch`, `amountOf`, `fullName`, `isRaw`, `fieldOf`, `rawsOf`.
- **`accountTokenCodec(provider)`** in `@wirecat/cli-core/oauth`: a sign-in entry bound to one CRM account through
  the owner's own app, which keeps the app's secret, the account's `host` and `userId` beside the tokens and saves a
  rotated refresh token.
- **`@wirecat/cli-core/crm/testing`:** `fakeCrmSource` has `list`, `get`, contact and company writes, and `admin` and
  `ownClients` options; `crmSourceContract` checks live pages and `get`, and `crmWriteContract` contact and company
  writes.

### Changed — may break callers

- **`CrmWriter.create` and `update` take every CRM kind** (`CrmDrafts[K]`, `CrmWriteFields[K]`) and answer
  `CrmRecords[K]`; `CrmWriteCapabilities.kinds` and the `alsoChecks` hooks take `CrmKind`. A writer that writes only
  deals and leads casts its answer and leaves `person` and `organization` out of `kinds`.
- **`CrmPerson` and `CrmOrganization` carry what a live read answers:** `assignee`, `createdAt`, `updatedAt`, a
  person's `firstName`, `lastName`, `url` and `metadata`, a company's `phones` and `emails`. The store does not keep
  them yet.
- **`fakeCrmSource` writes every kind by default** and counts `list` and `get` in `calls`.
