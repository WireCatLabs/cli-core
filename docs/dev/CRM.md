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
  terms. `query.limit` is at most 250. `query.page` is the page number from 1: a CRM that pages by number passes it
  on, one that pages by offset turns it into one with `crmWindowOf(query)` and reads with `walk`.
- `CrmSource.get(kind, id)` answers one record by the CRM's id, or `null`. `show` takes an id or an exact name: no
  record by that id, it lists by the name and takes the one whose whole name matches; two are refused with both
  (`crm.record-ambiguous`).
- `users list|show` read `CrmSource.users()` once a run and filter by `name` and `active` themselves.

Each record carries its custom values in `metadata`, labelled by `crmValues.crmValuesOf`. A phone or e-mail never
goes there, since the foreign rule strips only `phones` and `emails` (`crmSourceContract` checks it). Phones and
e-mails come out as `{value, type}`, the type from `contactTypes`; a company lists its contacts in `person_ids`
(`people`). Lists read the custom field definitions the last sync stored, and the CRM only before the first sync. The
answers are `crm_person`, `crm_organization` and `crm_user`, one mapper each (`crmPersonOf`, `crmOrganizationOf`,
`crmUserOf`).

## Writes

`CrmWriter.create` and `update` take every kind in `capabilities.kinds`; a contact or company takes only these two.
`people create|update` and `organizations create|update` run `createCrmRecord` and `updateCrmRecord`: the same
guard, keys, journal and `operation_id` as `deals create`, the keys `people.create`, `organizations.update` and so on,
and `crm.assign-others` for an owner other than the sign-in's user. The CRM's answer is stored by `savePeople` or
`saveOrganizations`, as a sync would, but only when it is the sign-in's own client: a write of anyone else's answers
it without phones and e-mails, spends none of the day's views, and says `stored: false`. An update that gives a
company to someone else removes it from the copy; a contact stays until a sync's scope removes it.

A contact's e-mails and phones are in `CrmPersonFields` for an adapter's own use; the commands do not offer them,
since the shared flag vocabulary has no `--email` or `--phone` yet.

## Foreign contacts

The owner's rule (NEED-2487, NEED-2660): anyone but the CRM's administrator sees the phones and e-mails only of their
own clients, and at most `DAILY_FOREIGN_CONTACTS` (100) other contacts or companies a UTC day in `show`. The rule
applies when the source has `isAdmin()`. A record is the sign-in's own when its `assignee` is `self()` or
`ownClients(kind, ids)` names it. `foreignContacts(source, file)` strips the lists and spends on `show`; the day's
count is a file per CRM user in the CLI's state folder (`foreignContactsPathFor`), read and written under
`withFileLockAsync`. A stripped record also loses each custom value whose field definition has `holds` (`phone` or
`email`) and each that repeats one of its own phones or e-mails. The definitions are read from the CRM once a run,
since the store does not keep `holds`; with none, every custom value of a foreign record goes. An adapter sets
`holds`: amoCRM for a `multitext` field whose `field_code` is `PHONE` or `EMAIL`, Bitrix24 for its phone and e-mail
field types.

`api call` of a method that reads contacts or companies is the administrator's only: the CLI decides which methods
read clients and calls `refuseForeignClientReads(source, readsClients, method)` before sending
(`crm.client-reads-admin-only`), as Bitrix24's `readsClients` does.

## Adapter helpers

- `providerCall({ write, send, pace, refresh })`: one call, paced by the profile's `Pacer`. Reads are tried again on
  a retryable failure or `rate_limited`, writes only on `rate_limited`. A write cut off (timeout, network, provider
  unavailable, a cancel) or answered with a body nobody can read is `outcome_unknown` and never sent again.
  `refresh` runs once on `authentication_error` with reason `oauth.expired`.
- `walk(window, largest, fetchPage)`: an answer page read over the CRM's own page sizes, one row more than asked, so
  `hasMore` is known without a total.
- `conditionsOf(terms, fields, hooks)`, `customNames`, `filterableFields`, `withCustomFields`, `customConditions`,
  `wantedCodes`, `selectedCodes`: a query into conditions; `hooks.time` and `hooks.numeric` give a CRM its own value
  types.
- `crmCustomValues(fields, pairs)`: `--field` pairs into codes and option ids.
- `crmValues`: JSON coercions (`crmValues.text`, `id`, `ids`, `number`, `time`, `epoch`, `amountOf`, `fullName`,
  `isRaw`, `fieldOf`, `rawsOf`, `crmValuesOf`).
- `accountTokenCodec(provider)` in `@wirecat/cli-core/oauth`: a sign-in entry through the owner's own app, which
  keeps the app's secret, the account's `host` and `userId` and saves a rotated refresh token. A new sign-in takes
  `host` and `userId` from its own `extra` only. The codec is `rotating`: a run with moved folders never refreshes it
  (`oauth.moved-rotating`), since the rotated token would land in the temporary entry and leave the owner's dead.
- `@wirecat/cli-core/crm/testing`: `fakeCrmSource` (strict: a condition it does not know fails), `crmSourceContract`
  and `crmWriteContract` cover the live reads and the contact and company writes.
