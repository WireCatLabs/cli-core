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
  names them) and at most `DAILY_FOREIGN_CONTACTS` (100) other contacts or companies a UTC day in `show`, by id or
  exact name. The count is kept per CRM user under a file lock, so two runs never both take the last slot
  (`foreignContacts`). A write of a foreign contact answers it stripped and does not store it (`stored: false`); an
  update that gives a company to someone else removes it from the copy. A foreign record's custom values go where the
  field definition says it holds a phone or an e-mail (new `CrmField.holds`), or all of them when the CRM gives none.
- **Helpers every CRM adapter needs**, from `@wirecat/cli-core/crm`: `providerCall` (paced calls, reads retried, writes
  retried only on `rate_limited`, a write with no answer `outcome_unknown`, one token refresh on `oauth.expired`),
  `walk` and `crmWindowOf` (the CRM's pages into one answer page with `hasMore`), `conditionsOf` and the custom-field
  query helpers, `crmCustomValues` (`--field` pairs), `crmValues` (JSON coercions and `crmValuesOf`, custom values
  with labels), and `refuseForeignClientReads` for an `api call` that reads clients.
- **`accountTokenCodec(provider)`** in `@wirecat/cli-core/oauth`: a sign-in entry bound to one CRM account through
  the owner's own app, which keeps the app's secret, the account's `host` and `userId` beside the tokens and saves a
  rotated refresh token. It is `rotating` (new `TokenCodec.rotating`, `TokenStorage.rotating`): a run with moved
  folders refuses to refresh it (`oauth.moved-rotating`).
- **Money is checked before a deal write is sent:** a currency or a precision the store cannot keep is refused
  (`money.currency`, `money.amount`). A list option label two options share is refused with both
  (`field.ambiguous-option`).
- **`@wirecat/cli-core/crm/testing`:** `fakeCrmSource` has `list`, `get`, contact and company writes, and `admin` and
  `ownClients` options; `crmSourceContract` checks live pages and `get`, and `crmWriteContract` contact and company
  writes.

### Changed — may break callers

- **`CrmWriter.create` and `update` take every CRM kind** (`CrmDrafts[K]`, `CrmWriteFields[K]`) and answer
  `CrmRecords[K]`; `CrmWriteCapabilities.kinds` and the `alsoChecks` hooks take `CrmKind`. A writer that writes only
  deals and leads casts its answer and leaves `person` and `organization` out of `kinds`.
- **`CrmPerson` and `CrmOrganization` carry what a live read answers:** `createdAt`, `updatedAt`, a person's
  `firstName`, `lastName`, `url`, `metadata` and `contactTypes`, a company's `assignee`, `phones`, `emails` and
  `people`. Of these the store keeps a contact's `assignee` only.
- **`fakeCrmSource` writes every kind by default:** `FakeCrmWrite.kind` is any `CrmKind`, and `calls` counts `list`
  and `get`.
- **`crmSourceContract` asks more of a source:** a source with `list` must list at least one contact and one company,
  give back every id the fixture names in its new `live`, and keep phones and e-mails out of `metadata`.
  `crmWriteContract` runs contact and company cases for a writer whose `kinds` include them.
- **A `providerCall` write that ends in `cancelled` or `invalid_response` is `outcome_unknown`.**
- **`CrmOrganization.metadata` is `Record<string, CrmValue>`**, as a person's; `EncodeInput` gains `signIn`.
