# CRM

What a CRM CLI (b24, amo) gets from `@wirecat/cli-core/crm` and `/crm/cli`, and what its adapter supplies.

- [The port](#the-port)
- [Live reads](#live-reads)
- [Writes](#writes)
- [Foreign contacts](#foreign-contacts)
- [Activities, changes and the digest](#activities-changes-and-the-digest)
- [Adapter helpers](#adapter-helpers)

## The port

`CrmSource` is one CRM account as its adapter reads it: `pipelines`, `changes` (the sync's change feed), `fields`,
`ids`, `users`, `departments`, `activities`, `stageHistory`. `syncCrm` copies the owner's own deals, leads, contacts
and companies into the store. The copy is never the whole CRM (NEED-2661), so another client is found by a live read.
An activity's `on` may name contacts and companies as well as deals and leads; `stageHistory` is read on every sync,
and the funnel, `deals show` and the stage tasks count it.

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
contact or company to someone else removes it from the copy (`store.crm.removeContact`, `remove`), the contact with its
identity's phones and e-mails, and the activities on nothing but it are marked deleted. The answer says `removed`.
`removed: false` means the copy keeps the contact: one of the owner's kept deals or leads names it (the sync would copy
it back), the owner decided about its identity link, or something else points at it.

`--email <address>` and `--phone <phone>`, each repeated for more, replace the contact's or company's whole list
(`CrmPersonFields`, `CrmOrganizationFields`); a phone is taken in international form only and sent as E.164. An
empty value clears the list. An adapter maps both lists for both kinds; `crmWriteContract` checks a company's phone
and e-mail.

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

### Offline reads of the copy

One account's copy is kept once, whichever profile synced it, so another profile on the same account must not read it
past the rule above. `CrmRun.user` is the profile's own CRM user, read from its sign-in entry without the network; it
is required, and `null` when the sign-in names none or the CRM limits nobody. Each `sync` records, as a sync state the
`config` command cannot set, whether the CRM limits its users (the source has `self()` or `isAdmin()`) and whether its
sign-in's user is the administrator; it records this before it refuses a sign-in that is not the copy's owner, so
another administrator's first sync is enough. `crmViewerOf` turns that into a `CopyViewer`: none for the administrator
or a CRM that limits nobody, otherwise only the deals and leads assigned to `user`, and none of them when `user` is
`null`. With `user` `null`, or a copy no sync of this version recorded, the answer carries a note saying why and what
to do, and `complete: false`.

`deals`, `leads`, `pipelines` and `stages` reads and `search all` pass the viewer to the store, which filters the rows,
the stage counts, the funnel and the deals whose contacts' e-mails and phones `search all` matches; `show` of a row
the viewer may not read is `not_found`. A deal's contacts are then the profile's own clients, so no quota applies
offline; another client is read live, under the rule above. `search all` of a limited profile reads only its own
account's copy; anyone else's reads each other account's copy by that copy's rule for its owner (the `self` setting),
and a copy with no owner as none. `store status` counts the whole copy and says so to a limited profile.

Known limits:

- The commands enforce the rule; the file does not. The store is one SQLite file of the OS user: `store backup`, or
  `sqlite3` on the file, reads every row, and an edited user id in a sign-in kept in a file names another user. It
  keeps an agent working through the commands to its part, not someone with the file.
- A demoted administrator reads the whole copy until a sync of its own records that it no longer is one.
- A user that is not the administrator reads offline only the deals assigned to it, even in a copy its own sync made:
  the unassigned deals and the colleagues a `mine` scope chose stay hidden from it.

## Activities, changes and the digest

These read the copy only.

- `activities list` is mounted with `addCrmCommands(program, { activities: true })`, for a CLI whose adapter has
  `activities`. It answers `crm_activity`: open ones first by due time, then the rest, newest first, `status:open`
  unless a status or `overdue:` is given. With the account's `activities` setting off it answers no items and a
  `missing` entry that names the setting.
- `changes list` is always mounted. It answers `crm_change`, newest first, over a window (`at:`, the last day by
  default): `created`, `moved`, `won`, `lost`, `owner_changed`, `activity_added`, `activity_done`, `person_added`
  (`CRM_CHANGES`). One SQL over the stage entries, owner changes, activities and contacts reads it
  (`store.crm.changes`, `crm-changes.ts`). A won or lost row with no exact stage entry takes noon UTC of its closed
  day, `exact: false`.
- `changes list --format report` prints `crmDigest`'s `wirecat.report/1` document: one `crm` section (overdue CRM
  tasks, those due today, won, lost, moved, new, new owners, new contacts as a count, tasks the stage rules opened),
  capped by `SECTION_CAPS.crm`, and `health` when the last sync is older than a day. A `command` schedule whose
  output is such a document is rendered and delivered like an agent's report (`isReportAnswer`), so
  `schedule command crm-digest --daily 08:00 --deliver-to … -- changes list "at>=1d" --format report` is the CRM
  morning digest.

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
- `@wirecat/cli-core/crm/testing`: `fakeCrmSource` (strict: a condition it does not know fails; `stageHistory` and
  `activities` options give it those reads), `crmSourceContract` and `crmWriteContract` cover the live reads and the
  contact and company writes, and `crmSyncContract` the sync (a fixture's `activitiesOn` adds the activity case).
