# Plan — one `--source` for every search

Status: **draft, waiting for the owner's review of the value grammar.** No code yet.

## Goal

The owner chooses which accounts a search reads the same way in every search, for every kind of thing
the store holds: messenger accounts, mailboxes, notes folders, Google Drive profiles and meeting
accounts. The answer says which accounts were read. Owner, 2026-10-13: "make sure we can control which
profiles we filter by in all entities". The standing rule applies: nothing picks an account for the
owner, and a read across accounts covers all of them and says so ([STANDARD.md, Command names
rule 1](STANDARD.md#command-names)).

## Current state

Anchors are on `origin/main`, 2026-10-13.

1. **Each search chooses accounts its own way.**
   - `search messages`: the active profile's account by default; `--source` or a positive `in:` widens
     it (`src/services/messages-search.ts:149-158`, [query-language.md](../search/query-language.md)
     "Default scope").
   - `search mail`: every mailbox (`src/services/search-kind.ts:66`); `--account <address>` narrows to
     one (`src/cli/messenger/messages-search-command.ts:50-51`, `search-kind.ts:77-83`). It has no
     `--source` (`messages-search-command.ts:50-58`). `--account` shipped in cli-messaging 0.233.0;
     STANDARD's catalogue still marks it planned for tg and max (`parity.json`, `search mail`).
   - `search notes`: every folder; `--folder <id>` narrows, repeatable (`search-command.ts:157-161`).
   - `search all`: no account option. Messages read every account (`source: "all"`,
     `src/services/search-all.ts:104`) except with `--backend server`, which reads the active account
     only (`:103`); mail reads every mailbox (`:116`); notes read every folder (`:141-147`).
   - Meetings in `search all`: `--meetings provider:account`, or a bare `--meetings` for the one stored
     account that holds meetings; several such accounts is an error that names them
     (`src/services/search-all-meetings.ts:150-160,171-204`).
2. **The `--source` list already exists.** `accountsOfList` takes `group:<name>`,
   `<app-or-messenger>:<account>` and bare words (`src/search/account-list.ts:98-137`). An account is
   found by its store id, by a profile any app recorded, or by its name (`:67-91`). Profiles are a
   store setting every messenger CLI writes on its first save (`src/cli/messenger/stored.ts:43`,
   `src/store/sqlite/account-groups.ts:35-50`). The parser reads `storedAccounts()`, which holds every
   `accounts` row, folders and meeting accounts included (`src/store/sqlite/accounts.ts:82-83`).
3. **Folders have two ids.** A folder is an `accounts` row of provider `folder` whose `external_id` is
   a ulid (`src/store/sqlite/notes.ts:371-379`). Notes hits and `--folder` use the row id instead
   (`notes.ts:319`, `search-all.ts:158`). The list parser matches `external_id`
   (`account-list.ts:70`), so a folder id from a hit does not resolve today.
4. **The store does not know drive's profiles.** drive names its folder `google-drive:<principal>`,
   where the principal is Google's `permissionId` (`drive-cli/src/store.ts:17`,
   `drive-cli/src/google.ts:62-66`). The profile name lives in drive's own config only
   (`drive-cli/src/config.ts:14-19`); drive never calls `saveProfile`. A document records its folder
   (the row's `account_id`), so the folder is the link from a document to a profile.
5. **`notes` is also a legacy provider.** Notes stored as messages before store version 25 have
   provider `notes` (`search-kind.ts:11-12`). A `notes:` entry would reach that provider first.
6. **`in:` reaches every resource of `search all` with the same text.** Notes understand `in:notes`
   and `in:note` and match nothing for any other value (`src/store/sqlite/note-search.ts:239`). Mail
   rejects a non-mail `in:` (`search-kind.ts:61-65`), so `search all` skips mail with that reason.
7. **`search all` does not say which accounts it read.** It answers `searched` (resources only) and
   `skipped` (`search-all.ts:40-42`). `search messages` already answers `coverage.accounts`
   (`src/services/messages-search.ts:61`), and `search all` drops it (`search-all.ts:115-117`).
8. **Drive hits look like notes.** A Drive document hit says `provider: "notes"`, `account: <folder
   row id>`, and the time drive last saved the text (`search-all.ts:155-163`). The Google URL and the
   Google edit time are in front matter, `sourceUrl` and `modifiedAt` (`drive-cli/src/store.ts:63-72`).
9. **memo picks an account.** `searchEverywhere` passes `accounts.find(provider !== "notes")` as the
   running account and `command: "tg"` (`cli-memo/src/search/command.ts:264,277`). With a `--source`
   list, `providerOf` would read `tg:` as that first account's provider (`account-list.ts:55`). It is
   the fallback the standing rule forbids.

## Decision

**`--source` is the one account option of every search, and a positive `in:` keeps its bare words.**
No new option. One rule makes the grammar guessable:

> **A `--source` entry is what a hit prints as `provider:account`.** Every hit's `provider:account`
> can be pasted back into `--source` to search that account alone.

Why extend `--source` and not add an option: the list, groups and profile names already exist and
already mix messengers and mailboxes (point 2); a second selector would be the "two ways for one
thing" that Command names rules 4 and 5 forbid.

### Value grammar

A comma list. An entry is one of:

| Entry | Means | Hit prints |
|---|---|---|
| `all` | every account of every resource the search reads | — |
| `telegram`, `tg`, `max`, any stored messenger | every account of that messenger | — |
| `personal`, `bots` | every personal or bot messenger account | — |
| `email` | every mailbox | — |
| `notes` | every notes folder, and the notes written in memo — not drive's folders | — |
| `drive` | every folder drive recorded (below) | — |
| `meetings`, or a meeting provider (`zoom`) | every meeting account, or that provider's | — |
| `<messenger>:<account>` | one messenger account: store id, a recorded profile, or the account's name | `telegram:123` |
| `email:<address>` | one mailbox | `email:me@work.example` |
| `notes:<folder>` | one notes folder: its id as `memo folders list` shows it, or its name | `notes:4` |
| `notes:internal` | the notes written in memo | `notes:internal` |
| `drive:<profile>` | the folder of one drive profile | `drive:work` |
| `<provider>:<account>` for meetings | one meeting account | `zoom:<account>` |
| `group:<name>` | the entries saved in `accountGroups.<name>`; may now hold any entry above | — |

- **`notes`, `drive` and `group` are reserved prefixes**, checked before profiles and providers, so
  the legacy `notes` provider (point 5) is never reached through `--source`. `search notes` reads the
  notes table, not those rows.
- **`notes:<folder>` takes the row id** (point 3), the id hits, `--folder` and `memo folders list`
  already show; the ulid stays internal.
- **A bare `drive` is drive's folders only.** It reads `profiles.drive` (point 4, below), never every
  `folder` row; `account-list.ts:105-114` today would turn it into every folder, memo's included.
- A positive `in:` takes the bare words of the table (`in:drive`, `in:email`), as today for
  messengers. `--source` with a list and a positive `in:` together stay an error.

### What the drive switch writes

On every sync drive calls the existing `store.saveProfile("drive", <profile>, { provider: "folder",
account: <folder external id> })`. It writes only when the value changes
(`account-groups.ts:35-50`). No migration: it is the `profiles` key of `store_settings`. Without it,
`drive:<profile>` is an error: "drive has not recorded profile <profile> in this store — `drive
<profile> folders sync` records it".

### Per resource

Each search takes from the list the entries of the kinds it reads.

| Search | Reads | Default with no `--source` | An entry of another kind |
|---|---|---|---|
| `search messages`, `search conversations` | messenger accounts | the active profile's account (unchanged) | error, as for mailboxes today (`search-kind.ts:50-58`) |
| `search mail` | mailboxes | every mailbox (unchanged) | error |
| `search notes` | notes folders, memo's notes, drive folders | all of them (unchanged) | error |
| `search all` | each resource its own entries | every account of every indexed resource; meetings not searched (Q3) | the resource with no entry is skipped (Q1) |

- **`search all` with a list** splits it per resource. A resource that gets no entry is not read
  and appears in `skipped` with the reason `--source names no <resource> account`. `--only` still
  picks resources; the two intersect (Q4).
- **`--backend server` in `search all`** keeps asking the server for the active account only; the
  answer's `accounts` (below) says so, instead of implying every account.
- **Drive documents stay in the `notes` resource.** They are `documents` rows that `searchNotes`
  already reads (drive plan, point 4); `drive:` entries narrow its folders. A separate resource would
  change `--only` and `searched` values and is not needed for scoping.

### The answer says which accounts were read

`search all`, `search mail` and `search notes` answer a top-level `accounts`:

```json
"accounts": [
  { "resource": "messages", "provider": "telegram", "account": "123" },
  { "resource": "mail", "provider": "email", "account": "me@work.example" },
  { "resource": "notes", "provider": "notes", "account": "4" },
  { "resource": "notes", "provider": "drive", "account": "work" }
]
```

- The keys are `SearchCoverage.accounts`' (`messages-search.ts:61`) plus `resource`; `search
  messages` keeps answering `coverage.accounts` and is not changed. `searched` and `skipped` keep
  their shapes (`search-all.ts:40-42`).
- Pretty mode prints one stderr line: `searched: telegram:123, email:me@work.example, notes:4, drive:work`.

### Fields of a Drive document hit (owner Q2 of the drive plan: yes)

Existing keys keep their names; `ref` versus `reference` is cm#1018's open NEED-986 and is not touched.

| Key | Drive document | Other notes |
|---|---|---|
| `kind` | `note` (unchanged) | `note` |
| `provider` | `drive` | `notes` |
| `account` | the drive profile from `profiles.drive`; the folder id when none is recorded | folder id, or `internal` |
| `timestamp` (`search all`), `modifiedAt` (`search notes`) | front matter `modifiedAt`: the last edit in Google; the row's `updatedAt` when it is missing | the row's `updatedAt` |
| `url` (new) | front matter `sourceUrl` | absent |

`url` is the key meetings and attachments already use (`src/meetings/model.ts:154`,
`src/store/sqlite/messages.ts:217`). It is absent, not `null`, where there is none. `search notes` hits
gain the same `url`. Pretty mode prints the URL after the title.

### What happens to `--folder`, `--account` and `--meetings`

Proposed, for the owner (Q2, Q3): each is a second way to choose accounts once `--source` covers
them.

- `search notes --folder <id>` → `--source notes:<id>`. Removed; release notes under "may break
  scripts" (Command names rule 9).
- `search mail --account <address>` → `--source email:<address>`. Removed. tg and max have not taken
  it yet (`parity.json`), so few scripts can depend on it.
- `search all --meetings provider:account` → `--source zoom:<account>`. The value form goes. The bare
  `--meetings` decides Q3.

## Work

Releases of this package, in order; each is one PR.

1. **Document hit fields** (drive plan item 1): `provider: "drive"`, `account`, `timestamp` and `url`
   above, in `searchAll` and `searchNotes`. Profile names come from `store.profiles()`. Ships with
   cm#1017, before the drive switch.
2. **Grammar**: reserved `notes`, `drive`, `group` prefixes; `notes:<row id|name>`,
   `notes:internal`; `drive` and `drive:<profile>` through `profiles.drive`; meeting entries; groups
   may hold them. `config set accountGroups.*` accepts the new entries. Parser tests.
3. **`search all --source`** per resource, `skipped` for a resource with no entry, `accounts` in the
   answer, the stderr line. `in:` bare words resolved once before the resources are asked.
4. **`search notes --source`, `search mail --source`**, `accounts` in their answers; the removals the
   owner approves. `parity.json` rows; MCP schemas (`search_all`, `search_notes`, `search_mail`) take
   `source` and lose the removed fields.
5. **cli-memo**: `memo search all` takes `--source` and passes it through; it stops picking
   `accounts.find(…)` as the running account (point 9) and passes no account it did not get from
   the owner.
6. **drive-cli**, in the drive switch PR: record the profile (above).

Order against the drive switch: item 1 lands in the cli-messaging release drive#19 and the switch pin
(drive plan, "Release order"). Items 2–4 can follow in a later release; until drive records its
profiles, `drive:<profile>` answers the error above, and a bare `drive` matches nothing and says so in
`skipped`. tg and max take items 2–4 with their next cli-messaging bump.

## Tests

- Parser: every row of the grammar table resolves; `notes:` never reaches the legacy provider; bare
  `drive` excludes memo's folders; `drive:<profile>` without a record names the sync command; a
  group holding `notes:` and `drive:` entries; an unknown folder lists the folders there are.
- `search all`: a list with only `telegram:<id>` reads that account and skips mail and notes with the
  reason; `--only notes --source drive:work` reads one folder; `accounts` lists exactly what was read;
  with `--backend server` it lists the active account only.
- Round trip: for each hit kind, `--source <hit provider>:<hit account>` returns that hit again.
- Drive fields: a fixture document with `sourceUrl` and `modifiedAt` gets `url` and Google's time; a
  memo note gets neither.
- `search notes` and `search mail` with an entry of another kind fail with a validation error.
- Machine mode: the `searched:` line is on stderr only.
- memo: `memo search all --source tg:<profile>` resolves through tg's recorded profile, not the
  first stored account.

## Open questions for the owner

- **Q1 · When `search all --source` names accounts of only some resources, should the others be
  skipped?** Example: `search all budget --source telegram:work` — read only that Telegram account and
  skip mail and notes, or read that account plus every mailbox and folder? Recommend **skip**: the
  list is the whole scope, and `skipped` says what was left out.
- **Q2 · May `search notes --folder` and `search mail --account` go, replaced by `--source
  notes:<id>` and `--source email:<address>`?** Keeping them is two ways to do one thing. Removing
  `--folder` breaks scripts that use it. Recommend **remove both** in the release of work item 4, named
  under "may break scripts".
- **Q3 · Should naming a meeting account in `--source` also turn on the meeting search, so
  `--meetings` goes entirely?** Meetings have no search index; each is read one by one, up to
  `--max-meetings`, so they are off by default. Recommend **yes**: `--source zoom:<account>` or
  `--source meetings` searches meetings; with no meeting entry, `skipped` says "meetings: not searched
  — name a meeting account in --source". `--max-meetings` stays.
- **Q4 · Should `--only` stay beside `--source` in `search all`?** `--only` picks resources,
  `--source` accounts; `--only mail` and `--source email` overlap. Recommend **keep `--only`**: it
  picks resources and leaves each one's default accounts, which `--source` cannot say without
  listing every account.
