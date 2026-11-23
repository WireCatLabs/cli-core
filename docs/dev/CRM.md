# CRM

What a CRM CLI (b24, amo) gets from `@wirecat/cli-core/crm` and `/crm/cli`, and what its adapter supplies.

- [The port](#the-port)
- [Live reads](#live-reads)
- [Writes](#writes)
- [Foreign contacts](#foreign-contacts)
- [Activities, changes and the digest](#activities-changes-and-the-digest)
- [Client files](#client-files)
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

The owner's rule (NEED-2487, NEED-2660, NEED-2703 B): anyone but the CRM's administrator sees the phones and e-mails
only of their own clients, and reads at most `DAILY_FOREIGN_CONTACTS` (100) other people's records a UTC day: a
contact or company in `show`, or the files of a deal, lead, contact or company. The rule applies when the source has
`isAdmin()`. A record is the sign-in's own when its `assignee` is `self()`, and a contact or company also when
`ownClients(kind, ids)` names it. One slot is keyed `<kind>:<id>`, so the same record again that day is free. `foreignContacts(source, file)` strips the lists and spends on `show`; the day's
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
the viewer may not read is `not_found`, and a lead's `deal` that it may not read is `null` (`withReadableDeal`).
A deal's contacts are then the profile's own clients, so no quota applies
offline; another client is read live, under the rule above. `search all` of a limited profile reads only its own
account's copy; anyone else's reads each other account's copy by that copy's rule for its owner (the `self` setting,
which only a sync records: `config set` of it is refused, SEC-201),
and a copy with no owner as none. `store status` counts the whole copy and says so to a limited profile.

Known limits:

- The commands enforce the rule; the file does not. The store is one SQLite file of the OS user: `store backup`, or
  `sqlite3` on the file, reads every row, and an edited user id in a sign-in kept in a file names another user. It
  keeps an agent working through the commands to its part, not someone with the file.
- A demoted administrator reads the whole copy until a sync of its own records that it no longer is one.
- A user that is not the administrator reads offline only the deals assigned to it, even in a copy its own sync made:
  the unassigned deals and the colleagues a `mine` scope chose stay hidden from it.

## Activities, changes and the digest

These read the copy only, under the offline rule above: a limited profile sees the activities on its own deals and
leads (and those on contacts alone that are assigned to it), and the contacts linked to its deals or assigned to it.
A hidden deal is never named in an activity's `on`.

- `activities list` is mounted with `addCrmCommands(program, { activities: true })`, for a CLI whose adapter has
  `activities`. It answers `crm_activity`: open ones first (overdue, then by due time, then undated), then the rest,
  newest first, `status:open` unless a status or `overdue:true` is given. With the account's `activities` setting off
  it answers no items and a `missing` entry that names the setting.
- `changes list` is always mounted. It answers `crm_change`, newest first, over a window (`at:`, the last day by
  default, read against the CLI's clock): `created`, `moved`, `won`, `lost`, `owner_changed`, `activity_added`,
  `activity_done`, `person_added` (`CRM_CHANGES`). One SQL over the stage entries, owner changes, activities and
  contacts reads it (`store.crm.changes`, `crm-changes.ts`); `store.crm.changeCounts` counts it by kind. A won or lost
  row takes the time of its stage entry when the CRM's history has one (`exact: true`), else noon UTC of its closed
  day, which east of UTC+12 is the next local day. Every row, won and lost too, is selected by that time, so a deal
  is in one window only. A move the CRM's history gives with no earlier entry in the copy is listed from the copy's
  own diff. A comment, call, e-mail or meeting that arrives done with no due date, as an amoCRM or Bitrix24 note,
  is listed once, as `activity_added`; a task or to-do keeps both lines, since it may be closed long after it was made.
  `page.next` carries the window in `--cursor`, so the next page reads the same rows.
- `changes list --format report` prints `crmDigest`'s `wirecat.report/1` document: one `crm` section. Won and lost
  come first and are never pushed out; then overdue CRM tasks, those due today, moves, new deals, new owners, new
  contacts as a count and the tasks the stage rules opened, each read with its own limit, and `more` from SQL counts.
  Only an activity's subject is shown, never its text; a phone number or an e-mail address in any text is masked, and
  a line break never reaches a field. A limited profile sees only the stage-rule tasks of its own deals and leads.
  `health` names a last `sync` that failed (`sync-failed`, kept as the sync state `crm:sync-failed`) or a kind older
  than a day. The window ends where the last complete `sync` started (the sync state `crm:synced-from`): a change
  the CRM made before then is in the copy, a later one may not be yet. The stage tasks a sync opens carry its start.
  Run by a schedule (`<PREFIX>_SCHEDULED`), it starts where that schedule's last run ended (the sync state
  `crm:digest:<schedule>`, moved only once the report is printed), so a late or missed run loses nothing. A row the
  CRM shows late with an older time, as an import, can still fall before the window. A `command` schedule whose output is such a document is rendered and delivered like an agent's
  report (`isReportAnswer`). Every command schedule's report skips the agent-text leak scrub, since its text is the
  store's data; the renderers still escape it, so
  `schedule command crm-digest --at 08:00 --deliver-to … -- changes list --format report` is the CRM morning
  digest. It sends deal titles, amounts, loss reasons, contact names and task subjects to every reader of the route:
  a group chat as a route shares them with the whole group.

## Client files

The files of a deal, lead, contact or company (NEED-2701 C): listed live, downloaded on demand, their text found by
`search all`.

- `CrmSource.files(owner)` reads one record's files live and answers its `assignee`, the CRM user id the day's limit
  checks. Each `CrmFile` has an opaque `id`, `<owner kind>:<owner id>:<source>:<provider id>` (`crmFileId`,
  `parseCrmFileId`), and `open()`, which asks the CRM for a fresh link each time and keeps it inside the adapter: a
  tokened link reaches no record, store row, error or answer. A kind of file the sign-in may not read is a
  `context.gap` naming the scope; the others still list. `null`: no such record, or the sign-in cannot see it.
- `withoutFileLinks(body)`: what a CLI's `api call` answers, with every file link replaced by `[link removed]`: the
  values of the download keys, folded (every `…Machine`, `DOWNLOAD_URL`, `downloadUrl`, `fileUrl`, `CALL_RECORD_URL`,
  `archiveLink`, `publicUrl`), amoCRM's `_links.download`, and any string holding a webhook (`/rest/<user>/<code>/`),
  `auth=`, `access_token=`, `api_token=` or `X-Amz-Signature=`, or a portal path (`/rest/`, `show_file.php`) with
  `token=`. A site the owner typed with `?token=promo` stays. `crmValuesOf` applies it to every custom value.
- Only a downloaded file has a row: `crm_files` (store version 68), with the owner record, its assignee at download
  as the identity a deal's assignee is kept as, the local path and the extracted text, in its own word index
  `crm_file_words`. It is not `attachments`, so no generic reader (`attachments list`, MCP `attachments_show`) shows a
  colleague's contract. `store.crmFiles` reads and writes it; `find` takes the copy's viewers: a limited profile finds
  only the files of records assigned to its user (NEED-2707 A), the administrator all. A deal's or lead's file follows
  the copy's current assignee, so it goes with a reassigned deal and is hidden while the copy lacks the deal; a
  contact's or company's keeps its assignee at download. The account's purge removes the rows.
  `account remove --delete-data` lists and deletes, before and after its confirmation alike, the files
  `store.crmFiles.savedPaths` names inside the CLI's state folder, one file at a time; a consumer must save its
  downloads under that state folder, or account removal leaves them on disk. A copy saved elsewhere is the owner's. `store.crmFiles.droppable` and `forgetFile` serve the disk cap: only files under the account's own folder
  that have text are dropped, the row and the text stay.

`addCrmCommands(program, { files: true })` mounts the commands, for a CLI whose adapter has `files`:

- `files list --deal|--lead|--person|--organization <id>` reads one record's files live (`--lead` only when the CRM
  has leads) and marks the downloaded ones with their `path`. A missing scope is a note and `complete: false`.
- `files download <id>` saves one file under `<state>/crm/files/<provider>-<account>/<kind>-<id>/` (folders 700, file
  600, the name through `safeName`, at most 200 bytes with its extension kept, and the provider's id in front when
  another file or another row holds the name), or under
  `--dir`, which is the owner's own copy: a file there that is not this file's earlier copy is never overwritten (then
  `<provider id>-<name>`, and `crm.file-exists` when both are taken or a file appears there during the download: the
  file is linked into place, never renamed over one). A repeat download removes the earlier copy the
  CLI kept in its folder. It takes 100 MB unless
  `--max-size <MB>`, up to 2048; a bigger file, or one of unknown size that passes the cap while it streams, is
  `crm.file-too-large` and leaves no part. The text goes through `extractText` into the row; the answer gives the first
  4,000 characters with `untrusted: ["name", "mime", "path", "text"]` (`files list` marks `name`, `mime` and `path`),
  never the bytes. A failed download never names the link
  (`crm.file-unavailable`); a cut-off one names `--timeout 10m`. A time limit that stops the download or the text
  reading keeps no file and no row (`cancelled` while reading), never a row that says `unreadable`.
- Both read `files(owner)` first, then spend the day's slot of a colleague's record, then look the id up: a made-up id
  on a colleague's record still costs its slot and is `not_found`. Listing and downloading the same record that day
  cost one slot. Admins and sources without `isAdmin` have no limit.
- `files sync` prefetches the files of the sign-in's own deals and leads (assigned to `self()`), changed since its
  last complete round and at most `files.days` back, newest first, paging through all of them. A record the CRM now
  assigns to someone else is skipped whatever the copy says, so it never downloads a colleague's file and never spends
  the limit; it never reads a contact's or company's files. A file the CRM did not give (`unavailable`) leaves its
  record for the next run, up to three runs, after which the round closes without it (`tries` in the round).
  `run_minutes` also bounds each download and its text reading: one cut off at the deadline keeps no part and stops
  the run as `deadline`. It keeps its place in the sync state `crm:files-round` and answers `complete: false`
  at a limit; the next run goes on. Run it with `schedule command crm-files --every 1h -- files sync`. `sync` never
  downloads a file. `files sync` checks `files.download` too, so denying downloads stops it.
- `files.download` is allowed by default (NEED-2708 B); `files.list` denied leaves file text out of `search all`.
- The account's limits are owner-only store settings `crm.<provider>:<account>.files.<name>`, refused out of range:

  | Setting | Default | Range |
  | --- | --- | --- |
  | `max_files` (a `files sync` run) | 50 | 1–500 |
  | `max_file_mb` (a prefetched file) | 20 | 1–50 |
  | `max_run_mb` (a `files sync` run) | 200 | 10–2000 |
  | `run_minutes` (a `files sync` run) | 10 | 1–60 |
  | `days` (how far back) | 7 | 1–90 |
  | `max_total_mb` (the account's folder) | 2000 | 100–50000 |

  A skipped file is in the answer with its reason, `too-large`, `run-files`, `run-mb`, `deadline`, `disk-full` or
  `unavailable`, and the `files download <id>` step. A download that would pass `max_total_mb` even after dropping is
  refused before it starts. Once it is saved, files are dropped only if it then fits: the oldest other saved files
  whose text is kept lose their file until it does; a scan is never dropped, nor a row naming the new file's path,
  and the file's own earlier copy is not counted. Still full, the new file is
  deleted, `files sync` stops with `disk-full` and `files download` is `crm.files-disk-full`.
- `search all` finds the stored text (`--only crm` too) as `crm_file` hits under the copy's viewer rule. memo's, tg's
  and the MCP's `search all` read them through the same `searchAll`, which then takes each copy's viewer for the
  user its own sync signed in as (`crmViewerOf`) for deal, lead and file hits alike, so a limited copy's colleagues'
  deals and files stay out there too. Only a CRM
  CLI knows its profile's `files.list` level.
- `fetchCrmFile(link, { hosts, headers })` is the adapters' download: https only, the account's own hosts only,
  redirects only on them, an HTML page refused, and no error naming the link.
- `crmFilesContract` in `@wirecat/cli-core/crm/testing` checks an adapter's `files`: the listing's shape and ids, a
  download saved 600 with its text found and its token nowhere, refused links, and the day's limit.

## A source from a manifest

A CRM with an OpenAPI spec can be a manifest instead of an adapter: `crmSourceFromManifest(manifest, { api, call,
hooks })` builds the `CrmSource` (design and evidence: cli-private `plans/2026-11-16-cli-factory/source-manifest.md`).

- `api` is the CLI's generated manifest; each entity names its operations by id. `call` sends one of them: in a CLI,
  `serviceApiCall` over the same fetch and token as the `api` group; in a test, the same over cli-base `fakeApi`.
- Paging comes from each operation's `pagination`; an operation without it names its rows with `items`.
- A path the answer does not have gives no key, never `null`: a read that did not select a field must not erase it.
- A path past the end of a list, or under a `null`, the answer has is `null`: Attio's `values.job_title.0.value` on
  an empty list clears the copy's position.
- A change read sorted by modified time names `keyset`: the next page starts at the last row's time, so a row that
  changes mid-round moves nothing under the next page (a service's own page token is an offset into a moving list).
  Past `cap` rows at one time the round answers `reset`.
- What a manifest cannot say is a hook: `after` per kind for one record (async, with the metered `call`),
  `extend(base, { call })` for whole methods (`self`, `activities`), `pipelines.<kind>.outcome(stage, pipeline,
  found)` for a stage's outcome the data cannot say (Attio names a lost stage only by its title). Bitrix24's `mine`
  scope is that kind of policy, and stays code.
- A pipeline call that answers the stages themselves (Attio's statuses, Pipedrive's `/stages`) sets `stages.each` to
  `.`: the stages group by `stages.pipeline`, or are one pipeline, and the pipeline's map reads its first stage.
- `custom.typed` reads values kept as a list of typed entries with their history (Attio's `values.<slug>`): the
  entry's type (`by`) picks the path of its value from `TYPED_VALUE_PATHS` or `typed.paths`, an entry with a time at
  `current` is history, and several current entries are a list. `fields.keep` takes `{ path, is }` as data.
- `entities.<person|organization>.search` names a call with `"{query}"`: the source then has a live `list` for
  `people list` and `organizations list`, words through `search` and none through `list`, paged by the operation's
  offset. A condition it cannot send is refused (`query.unsupported-field`), never dropped.
- `entities.<person|organization>.linked: true` copies only the contacts or companies a deal names, each read by its
  `get`, as Bitrix24's sync does; their ids are the deals' links, so one no deal names leaves the copy at the next full
  round. With `search`, every other one is read live. For a service whose contacts grow from mail (Attio).
- `crmManifestProblems(manifest, api, definitions)` checks every mapped path against the schema each operation
  answers; a CLI runs it in a test, so a wrong path fails before any sync.
- `hooks.enrich` reads more for a whole page in one batch before the map; `optional` makes a refused kind, or one the service says is not there (404), a gap;
  `select.max` caps the account's own fields in `{select}`; mapped fields are always asked for.
- `defineCli` and `parseCliConfig` (`@wirecat/cli-core/manifest`) give the whole CLI's `wirecat.config.ts`: identity,
  API description, sign-in preset, category and this source.
- `manifestVerify` (`@wirecat/cli-core/cli`) is `tokenSessionCommand`'s `verify` from the config's `auth.verify`: it
  sends the one operation, refuses a token the answer does not call `active`, and keeps the id and name the answer
  holds. `hostsFetch(hosts, environment.fetch)` is the fetch for it and the source: only the CLI's hosts, over a test's
  fake when there is one. A CLI made from the config holds no check of its own.
- Not yet: deletions named in the answer.
- `src/crm/manifest/manifest.test.ts` writes HubSpot's contacts, companies and deals as a manifest and runs
  `crmSourceContract`, faults included, against a strict fake of HubSpot's API.

### A test for a source from a manifest

A CLI made from `wirecat.config.ts` tests its source with no code of its own (`@wirecat/cli-core/crm/testing`):

```ts
for (const { name, run } of crmManifestContract(SOURCE, { api, definitions, hooks })) it(name, run)
```

- `crmManifestFake(manifest, { api, definitions })` is cli-base's strict `fakeApi` with a service behind it: three
  rows of each kind, sampled from the list operation's answer schema (`sampleOf`), with distinct ids and the values
  the map reads written where it reads them (names, the stage of a listed pipeline, times, an amount with its
  currency). Every operation pages by its own `pagination`, two rows a page; a change read keeps the rows whose time
  at `keyset.field` or `updatedAt` is at or after its since, oldest first.
- A kind with `changes` whose time the fake cannot write and read back (a function rule, an enum) fails when the fake
  is built: otherwise every row would look changed and the change cases would prove nothing.
- A call is matched to the manifest's call with the most fixed values in common (nested body fields included). A
  change read sent without its since, a read by an id the fake does not hold (other than the contract's
  `contract-missing-*`) and a call no route makes are refused and listed in `fake.refusals`.
- `crmManifestFixture` adds the source over it, the ids it holds per kind (`held`: a full list must give each, a
  change read must leave the untouched ones out), a dead cursor and the faults the manifest allows: `deny` when a
  contact or company has `get` (after checking that `get` reads the row), `change` when a kind has `changes`,
  `skewed` and `sameToken`. `crmManifestContract` runs `crmSourceContract` over it and fails a case whose calls the
  fake refused.
- A value written inside a union (Attio's seventeen value types) goes into the branch that has its path, so the strict
  fake takes its own answer.
- A rule that is a function, an `each` or a `{ value }` writes nothing: the row keeps the sample there. `self` and a
  live `list` come from hooks, so their cases pass without running unless the hooks add them. The dead cursor is
  answered by the source itself (`reset` for a cursor that is not a time) and never reaches the fake.

## One account, one profile

The store keeps one copy per CRM account, whichever profile synced it. `addCrmCommands({ account })` mounts
`account remove` (cli-core's `accountRemoveCommand`), which refuses `--delete-data` while another profile here holds the
same account, even one whose session ended (`conflict`, `account-remove.account-shared`); under `--dry-run` it warns
instead. `refuseTakenCrmAccount` refuses a sign-in to an account and user another profile is signed in to
(`conflict`, `session.duplicate`); `crmAccountClaim` is that refusal as `tokenSessionCommand`'s `claim`.

- `held(profile, { env, keyring })` says which account a profile holds: `account` as the store names it, `user` where
  one account has several users, `signedIn` while a sign-in is saved here. Unset, it is the account `session start`
  remembered (`recalledAccount`), signed in while the profile's entry keeps a token; `<PREFIX>_TOKEN` is no profile's.
- `removal` replaces parts of the removal: the sign-out's words, an OAuth entry among `secrets`. By default the
  sign-out only forgets `token:<profile>`, and `<state>/crm/<profile>` is removed.

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
- `@wirecat/cli-core/crm/testing`: `fakeCrmSource` (strict: a condition it does not know fails; `stageHistory`,
  `activities` and `files` options give it those reads; each fake file's link holds `FAKE_FILE_TOKEN`), `crmSourceContract` and `crmWriteContract` cover the live reads and the
  contact and company writes, and `crmSyncContract` the sync (a fixture's `activitiesOn` adds the activity case).
