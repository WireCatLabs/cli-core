# CRM

What a CRM CLI (b24, amo) gets from `@wirecat/cli-core/crm` and `/crm/cli`, and what its adapter supplies.

- [The port](#the-port)
- [Live reads](#live-reads)
- [Writes](#writes)
- [Foreign contacts](#foreign-contacts)
- [Adapter helpers](#adapter-helpers)

## The port

`CrmSource` is one CRM account as its adapter reads it: `pipelines`, `changes` (the sync's change feed), `fields`,
`ids`, `users`, `departments`, `activities`, `stageHistory`. `syncCrm` copies the owner's own deals, leads, contacts
and companies into the store. The copy is never the whole CRM (NEED-2661), so another client is found by a live read.

## Live reads

`addCrmCommands(program, { live })` mounts `people`, `organizations` and `users` list and show for the kinds in
`live`. They read the CRM, never the copy, and refuse `--offline`.

- `CrmSource.list(kind, query)` answers one page of contacts or companies, newest first. `query.conditions` are
  AND-ed `CrmCondition`s in the shared field names (`assigned_to`, `type`, `created_at`, `updated_at`) or a custom
  field's code; times are epoch ms, a list field's value its option id. `query.text` holds the free words and `name:`
  terms. `query.page` is the page number from 1, as text; `crmWindowOf(query)` gives the offset.
- `CrmSource.get(kind, id)` answers one record by the CRM's id, or `null`.
- `users list|show` read `CrmSource.users()` and filter by `name` and `active` themselves.

Each record carries its custom values in `metadata`, labelled by `crmValuesOf`. The answers are `crm_person`,
`crm_organization` and `crm_user`, one mapper each (`crmPersonOf`, `crmOrganizationOf`, `crmUserOf`).

## Writes

`CrmWriter.create` and `update` take every kind in `capabilities.kinds`; a contact or company takes only these two.
`people create|update` and `organizations create|update` run `createCrmRecord` and `updateCrmRecord`: the same
guard, keys, journal and `operation_id` as `deals create`, the keys `people.create`, `organizations.update` and so on,
and `crm.assign-others` for an owner other than the sign-in's user. The CRM's answer is stored by `savePeople` or
`saveOrganizations`, as a sync would. A contact's e-mails and phones are in `CrmPersonFields` for an adapter's own
use; the commands do not offer them, since the shared flag vocabulary has no `--email` or `--phone` yet.

## Foreign contacts

The owner's rule (NEED-2487, NEED-2660): anyone but the CRM's administrator sees the phones and e-mails only of their
own clients, and at most `DAILY_FOREIGN_CONTACTS` (100) other contacts or companies a UTC day in `show`. The rule
applies when the source has `isAdmin()`. A record is the sign-in's own when its `assignee` is `self()` or
`ownClients(kind, ids)` names it. `foreignContacts(source, file)` strips the lists and spends on `show`; the day's
count is a file in the CLI's state folder (`foreignContactsPathFor`), read and written under `withFileLockAsync`.

## Adapter helpers

- `providerCall({ write, send, pace, refresh })`: one call, paced by the profile's `Pacer`. Reads are tried again on
  a retryable failure or `rate_limited`, writes only on `rate_limited`. A write cut off (timeout, network, provider
  unavailable) is `outcome_unknown` and never sent again. `refresh` runs once on `authentication_error` with reason
  `oauth.expired`.
- `walk(window, largest, fetchPage)`: an answer page read over the CRM's own page sizes, one row more than asked, so
  `hasMore` is known without a total.
- `conditionsOf(terms, fields, hooks)`, `customNames`, `filterableFields`, `withCustomFields`, `customConditions`,
  `wantedCodes`, `selectedCodes`: a query into conditions; `hooks.time` and `hooks.numeric` give a CRM its own value
  types.
- `crmCustomValues(fields, pairs)`: `--field` pairs into codes and option ids.
- `text`, `id`, `ids`, `number`, `time`, `epoch`, `amountOf`, `fullName`, `isRaw`, `fieldOf`, `rawsOf`: JSON
  coercions.
- `accountTokenCodec(provider)` in `@wirecat/cli-core/oauth`: a sign-in entry through the owner's own app, which
  keeps the app's secret, the account's `host` and `userId` and saves a rotated refresh token. A moved run's writes go
  to its temporary entry (cli-base `Credentials`).
- `@wirecat/cli-core/crm/testing`: `fakeCrmSource` (strict: a condition it does not know fails), `crmSourceContract`
  and `crmWriteContract` cover the live reads and the contact and company writes.
