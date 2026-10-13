# Plan — one `--source` for every search

Status: **model approved by the owner, 2026-10-13** (NEED-10 A, NEED-11 A). Built: work items 2–4 (the
registry, `notes:<id>` and `notes:internal`, BUG-2, `--source` in every search with `accounts`, `in:` taking kinds and
aliases, the three removals). Next: work item 5 (cli-memo).

## Goal

The owner chooses which accounts a search reads the same way in every search, for every kind of thing
the store holds. The answer says which accounts were read. Owner, 2026-10-13: "make sure we can
control which profiles we filter by in all entities". The standing rule applies: nothing picks an
account for the owner, and a read across accounts covers all of them and says so ([STANDARD.md,
Command names rule 1](STANDARD.md#command-names)).

## The model

**Every stored thing has a kind, a provider and an account.**

- **Kinds are fixed:** `messages`, `mail`, `notes` (the owner's own notes and disk folders),
  `documents` (imported from a service: Google Drive now, Notion or Confluence later), `meetings`
  (Zoom now, Google Meet or Teams later). The kinds are the resource names `--only`, `searched` and
  `skipped` already use, plus `documents`.
- **Providers are open.** Each declares one kind and its aliases in one registry,
  `src/domain/providers.ts` (new). Adding a provider is one entry there; the grammar does not change.

| Provider | Kind | Aliases | Account |
|---|---|---|---|
| `telegram`, `telegram-bot` | messages | `tg`, `tg-bot` | the store's account id |
| `max`, `max-bot` | messages | | the store's account id |
| `email` | mail | | the address |
| `notes` | notes | | `internal` for notes written in memo; a disk folder's id as `memo folders list` shows it |
| `drive` | documents | `google-drive` | the drive profile |
| `zoom` | meetings | | the store's account id |

A word that is both a kind and a provider (`notes`) means the kind; today the two cover the same
accounts.

## Current state

Anchors are on `origin/main`, 2026-10-13.

1. **What is already keyed by provider and account.** `accounts(provider, external_id)` rows hold
   messenger accounts, mailboxes and meeting accounts (`src/store/sqlite/accounts.ts:82-94`); hits
   print them as `provider:account` (`src/services/search-all.ts:120-125`). Providers are free strings
   (`src/domain/models.ts:17`); `src/domain/providers.ts` gives each known one a kind and its aliases, and a
   provider it does not list is a messenger. The list parser (`src/search/account-list.ts`) resolves `tg` to
   `telegram` whatever app runs, unless the store holds a provider named `tg`.
2. **Kinds that lack a provider and account today.**
   - **notes, written in memo:** no account row. `search all` invents `notes` + `internal`
     (`search-all.ts:157-158`).
   - **notes, disk folders:** an `accounts` row of provider `folder` whose `external_id` is a ulid
     (`src/store/sqlite/notes.ts:371-379`). Hits and the list parser use the row id: a list
     names a folder `notes:<row id>` or by its name, memo's own notes `notes:internal`, and `folder:` is not a
     provider.
   - **documents:** the same `folder` rows, named `google-drive:<principal>`, where the principal is
     Google's `permissionId` (`drive-cli/src/store.ts:17`, `drive-cli/src/google.ts:62-66`). No `drive`
     provider, and the profile name lives only in drive's config (`drive-cli/src/config.ts:14-19`). A
     document hit says `kind: "note"`, `provider: "notes"` (`search-all.ts:155-163`).
3. **Each search chooses accounts its own way.**
   - `search messages`: the active profile's account; `--source` or a positive `in:` widens it
     (`src/services/messages-search.ts:149-158`).
   - `search mail`: every mailbox; `--source email:<address>` narrows.
   - `search notes`: memo's notes and every folder; `--source notes:internal,notes:<id>` narrows, in one store
     query (`withInternal` in `src/store/sqlite/note-search.ts`), so `--offset` pages one list.
   - `search all`: every account of every kind but meetings; `--source` names them, meetings included
     (`src/services/search-all-meetings.ts`).
4. **BUG-2, fixed.** `search messages` and `search mail` keep the accounts of their kind from a list, a bare
   kind or a provider alias, answer the rest as `skipped: [{ source, reason }]`, and fail only when nothing fits
   (`fitting` in `src/search/account-list.ts`). A bare `all`, `personal`, `bots` or a provider the store holds
   by that very name keeps the old path; it now drops meeting and notes accounts too. The `--language legacy`
   path filters the same way but does not answer `skipped`. A positive `in:` takes a bare provider, alias or the kind
   `messages` or `mail` (`sourceOf` and `inSource` in `src/search/query.ts`).
5. **`search all`, `search mail` and `search notes` say which accounts they read** as
   `accounts: [{ resource, provider, account }]`, with or without `--source`; `search messages` answers
   `coverage.accounts`.
6. **Groups exist.** `accountGroups` in `store_settings`, saved by `config set accountGroups.<name>`
   (`src/store/store.ts:1496-1505`), listed by `config show` (`src/cli/store-settings.ts:95`). A group
   lists entries, never another group (`account-list.ts:30-37`).

## `--source`: four shapes

A comma list. Each entry is exactly one of:

1. **`provider:account`** — one account: the same pair every hit prints, so a hit can be pasted back.
   The account is the store's id, or a profile an app recorded, or the account's name, as today
   (`account-list.ts:67-91`).
2. **A bare provider** or alias — all its accounts: `telegram`, `tg`, `email`, `drive`.
3. **A bare kind** — every provider of that kind: `messages`, `mail`, `notes`, `documents`,
   `meetings`.
4. **`group:<name>`** — the entries saved in that group.

`all`, `personal` and `bots`, which `--source` takes today, stay as built-in groups that need no
`group:` prefix: `all` every account, `personal` and `bots` the messenger accounts with and without
the `-bot` provider (`src/search/query.ts:6-17`; inside a list they hold messenger accounts only). The words `drive:` as a special case,
`notes:<folder>` as a special prefix and `zoom:` as a special entry from the reviewed draft are gone:
each is shape 1 or 2.

A positive `in:` takes shapes 2 and 3, as it takes bare words today. A list and a positive `in:`
together stay an error.

## Groups link profiles

- A group may hold accounts of any kind: `config set accountGroups.work
  tg:work,max:work,email:me@work.example,drive:work,notes:4`.
- **Linking is explicit**, never inferred from two profiles having the same name — the rule for
  `contacts link` ([STANDARD.md, Command names rule 3](STANDARD.md#command-names)).
- **Each CLI's login or profile-create step offers to add the profile to a group**: "Add this profile
  to an account group? [none / work / new…]". A yes runs the same write as `config set`. Built per CLI
  later (tg, max, memo mail, drive, zoom); not in this plan's code.
- `config show` lists the groups (already, point 6).

Declined, 2026-10-13: a profile's default group (the owner said no).

## Per search

Each search takes the entries it can use. The rest is named in `skipped`. It fails only when nothing in
the list fits it.

| Search | Kinds | Default with no `--source` |
|---|---|---|
| `search messages`, `search conversations` | messages | the active profile's account (unchanged) |
| `search mail` | mail | every mailbox (unchanged) |
| `search notes` | notes, documents | all of them (unchanged; documents live in the notes table) |
| `search all` | each kind its entries | every account of every kind; meetings only when named |

- `skipped` gains entries for unused list entries: `{ source: "<entry>", reason }` beside today's
  `{ resource, reason }`. Example: `search messages --source tg:work,email:me@x` searches `tg:work` and
  skips `email:me@x` with "a mailbox — search mail reads it". This fixes BUG-2.
- **`search all` with a list** gives each kind its entries. A kind with none is not read and appears
  in `skipped` as `{ resource, reason: "--source names no <kind> account" }`.
- **Meetings** have no search index, so `search all` reads them only when `--source` names a meeting
  account, provider or the `meetings` kind; otherwise `skipped` says meetings were not searched.
  `--max-meetings` stays. **One meeting account per search**: the meeting cursor binds to one account, so a list
  naming two that both hold meetings is an error that names both; of several, the one holding meetings is read and
  the rest are in `skipped`. Reading several waits for a cursor that spans accounts.
- **`--only` stays**: it picks kinds; `--source` picks accounts; the two intersect. `--only` gains
  `documents`.
- `--backend server` in `search all` still asks the server for the active account only; `accounts`
  says so.

### The answer lists the accounts searched, per kind

`search all`, `search mail` and `search notes` answer a top-level `accounts`:

```json
"accounts": [
  { "resource": "messages", "provider": "telegram", "account": "123" },
  { "resource": "mail", "provider": "email", "account": "me@work.example" },
  { "resource": "notes", "provider": "notes", "account": "internal" },
  { "resource": "documents", "provider": "drive", "account": "work" }
]
```

`resource` is the key `searched` and `skipped` already use for a kind. `search messages` keeps
`coverage.accounts`. Pretty mode prints one stderr line:
`searched: telegram:123, email:me@work.example, notes:internal, drive:work`.

## What the drive switch writes

On every sync drive calls the existing `store.saveProfile("drive", <profile>, { provider: "folder",
account: <folder external id> })` (`src/store/sqlite/account-groups.ts:35-50`; it writes only on a
change). No migration. That is how `drive:<profile>` names a folder and how a hit shows the profile.
Without the record, `drive:<profile>` fails: "drive has not recorded profile <profile> in this store —
`drive <profile> folders sync` records it", and a document hit prints `notes:<folder id>`, which is
still a valid entry.

## Fields of a document hit (drive plan Q2: yes)

`ref` versus `reference` is cm#1018's open NEED-986 and is not touched.

| Key | Drive document | Note |
|---|---|---|
| `kind` | `document` | `note` |
| `provider`, `account` | `drive` and the profile; `notes` and the folder id when no profile is recorded | `notes`, and `internal` or the folder id |
| `timestamp` (`search all`), `modifiedAt` (`search notes`) | front matter `modifiedAt`, the last edit in Google; the row's `updatedAt` when missing | the row's `updatedAt` |
| `url` (new) | front matter `sourceUrl` | absent |

`url` is the key meetings and attachments already use (`src/meetings/model.ts:154`,
`src/store/sqlite/messages.ts:217`); absent, not `null`, where there is none. Pretty mode prints it
after the title.

## Removed (may break scripts; changelog)

- `search notes --folder <id>` → `--source notes:<id>` (MCP `folders` → `source`).
- `search mail --account <address>` → `--source email:<address>` (MCP `account` → `source`).
- `search all --meetings [provider:account]` → `--source zoom:<account>`, `--source zoom`, `--source meetings`,
  or `--source all` for every account and the meetings (MCP `meetings` → `source`).

## Work

Releases of this package, in order; each is one PR.

1. **Document hit fields**: `kind: "document"`, `provider`, `account`, `timestamp`, `url`, in
   `searchAll` and `searchNotes`; `documents` in `searched`. Ships with cm#1017, before the drive
   switch (drive plan item 1).
2. **Registry and grammar**: `src/domain/providers.ts`; the parser resolves the four shapes through
   it; `notes:<row id>`, `notes:internal`; `drive:<profile>` through `profiles.drive`; groups may hold
   any entry. Each search filters by kind from the registry (BUG-2). Built, except `drive:<profile>`, which
   waits for the drive switch (item 6).
3. **`search all --source`**, `skipped` for unused entries and unnamed kinds, `accounts`, meetings by
   `--source`, `--only meetings` (built; MCP `search_all` takes `source`). `--only documents` waits for item 1.
4. **`search notes --source`, `search mail --source`**, `accounts` (`search notes` pages with `--offset`, so memo's
   notes beside some folders need one store query, not the two ranked searches `search all` runs); the three removals; `parity.json`
   rows; MCP schemas (`search_all`, `search_notes`, `search_mail`) take `source` and lose the removed
   fields. The user documents are rewritten in the same PRs: [query-language.md](../search/query-language.md),
   the generated `docs/commands.md`, the MCP descriptions. Built.
5. **cli-memo**: `memo search all` takes `--source` and passes it through, and prints a `skipped` entry by its
   `source` when it has no `resource`.
6. **drive-cli**, in the drive switch PR: record the profile (above).
7. **Each CLI**: the login and profile-create offer to join a group.

tg and max take items 2–4 with their next cli-messaging bump.

## Tests

- Registry: every provider has one kind; aliases resolve (`tg` → `telegram`) whatever app runs.
- Parser: each of the four shapes and the built-in groups; a group of mixed kinds; `drive:<profile>`
  without a record names the sync command; an unknown provider lists the registry's.
- Round trip: for each hit kind, `--source <hit provider>:<hit account>` returns that hit again.
- `search messages --source tg:<id>,zoom:<id>` searches the Telegram account and lists the Zoom one in
  `skipped`; `--source zoom:<id>` alone fails (BUG-2).
- `search all --source telegram:<id>` skips mail, notes, documents and meetings with the reason;
  `accounts` lists exactly what was read; with `--backend server` only the active account.
- Document fields: a fixture with `sourceUrl` and `modifiedAt` gets `url` and Google's time; a memo
  note gets neither.
- Machine mode: the `searched:` line is on stderr only.
