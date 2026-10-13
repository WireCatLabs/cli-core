# Glossary of command words and terms

One word, one meaning, in every WireCat CLI: tg, max, memo, drive and zm. This page lists the words for
commands, resources and JSON keys, the one meaning of each, the words it replaces, and where a CLI
uses it differently today.

- [STANDARD.md](STANDARD.md#command-names) binds all five CLIs. The verb, resource and flag meanings
  live in cli-base's vocabulary and are shown in [its tables](STANDARD.md#vocabulary-and-lint-rules);
  this page repeats a word only to show where it applies and where it is broken.
- Each CLI starts from its own lint baseline (`lint/baseline/`), which only shrinks; each repository
  fixes its violations in its own change.
- A rule changes in STANDARD first, in its own pull request, and the owner approves new wording.
  This page follows.
- "Current violations" were found on 2026-10-12 from `<cli> commands --json` (tg 0.51.0,
  max 0.48.0, memo and drive at their installed builds) and by reading the source. Nothing was
  renamed. Renames come in later pull requests, one per decision.

## Verbs

The last word of a command. Columns: **CLIs** where the verb applies today; **Not** the synonyms it
replaces; **Violations** the command paths that use another word for this meaning, or this word for
another meaning.

| Verb | One meaning | CLIs | Not | Violations |
|---|---|---|---|---|
| `list` | show many | all | `ls` | drive `shared-drives` (a list with no verb) |
| `show` | show one | all | `get`, `view` | tg/max `metadata get`, max `bot comments get`, drive `documents get`, `files get`, `comments get`, `permissions get`, `revisions get` |
| `search` | find by text, under `search <resource>` | all | `find`, `query` | drive `search` (root leaf, no resource), memo/drive `memories search` (a resource's own search leaf), tg/max `runs search` |
| `create` / `delete` | make or destroy a thing | all | `mkdir`, `trash`, `rm` | drive `files mkdir`, `files trash` (see NEED-991) |
| `add` / `remove` | put an existing thing into a set, or take it out | all | `rm`, `attach` | tg/max `contacts alias rm`; memo `folders attach` |
| `update` | change a thing's fields | all | `plan`, `edit` for fields | tg/max `tasks plan` (sets title, due date) |
| `set` / `unset` | one named key | all | `configure` | drive `models configure` |
| `sync` | bring the local store up to date from the source: only what changed, or the whole list where the source cannot say; `--all` for every chat or source (owner, 2026-10-12) | all | `import` for a catch-up, `refresh`, `store fetch` | tg/max `store fetch` (to become `messages sync`), memo `import` and `notes import` (to become `memo sync`), memo `mail <account> import`, tg/max `metadata refresh`, `stats messages counters refresh`; tg/max `contacts sync` help says "forget where the last sync left off and take the whole list again" — its help still describes a full re-read of the list, not only what changed |
| `fetch` | one bounded pull of one named thing from the messenger, not a catch-up | tg, max | `refresh`, `get` | tg/max `store fetch` (a catch-up, see `sync`); `bot store fetch` (STANDARD rule 10 wants the personal name, `bot messages sync`); `--refresh` options (`contacts context`, `search conversations`) |
| `import` | bring a file or list the user gives into the store or the messenger, once | all | — | memo `import`, `notes import` (a repeatable catch-up: `sync`) |
| `export` | write from the store to a file | all | — | none |
| `extract` | read the text inside files already on this machine into the store | tg, max | — | drive `memories extract` (sends text to a model and proposes memories: another meaning) |
| `link` / `unlink` | record that two identities are one person, or undo it | tg, max | — | tg/max `tasks link` (a task and what it concerns), memo `tasks link` (task to task), memo `projects meetings link`, drive `people link` (a Google user to a person); tg/max `messages link` (a view: the permalink) |
| `confirm` | the owner accepts what an agent proposed | memo, drive | `accept`, `approve` | memo `facts accept`, `actions approve` vs `relationships confirm`, `memories confirm` (three words, one meaning) |
| `reject` | the owner refuses what an agent proposed | memo | `decline`, `deny` | none in memo; tg/max `chats requests decline`, `replies consents deny` are the messenger's own words |
| `start` / `stop` | a running process or a login session | all | `on` / `off`, `enable` | tg/max `replies on` / `off`, memo `auto on` / `off`, tg `topics enable` |
| `pause` / `resume` | stop and restart what a running process does, without stopping it | tg, max | `snooze` for a process | none |
| `check` | verify, change nothing | tg, max | `audit`, `preflight` | tg/max `chats members audit`, memo `vocabulary audit`, `vocabulary preflight` |
| `cancel` | stop a job or a pending thing | all | — | none |
| `status` | how a thing stands right now | all | `readiness` | memo `tasks readiness` |
| `info` | facts about a singular thing itself | tg, max | — | none |
| `move` / `copy` | a file in the source | drive | — | none; not in STANDARD (drive only) |
| `restore` | put a backup back, or take a thing out of the trash | tg, max, drive | — | drive `files restore` (out of the trash: a second meaning) |

Verbs used but not in STANDARD's list, by CLI. Each needs a row above or a rename.

- tg/max: `accept`, `allow`, `answer`, `audit`, `build`, `decline`, `decrypt`, `deny`, `enable`,
  `exec`, `get`, `grant`, `mute`, `unmute`, `next`, `off`, `on`, `order`, `plan`, `press`, `put`,
  `refresh`, `reindex`, `retry`, `revoke`, `rm`, `run`, `send-as`.
- memo: `about`, `accept`, `ack`, `approve`, `ask`, `assign`, `attach`, `audit`, `poll`,
  `preflight`, `propose`, `ready`, `readiness`, `reject`, `relations`, `resolve`, `reverse`,
  `schedule`, `snooze`, `stale`, `suggest`, `on`, `off`.
- drive: `configure`, `copy`, `get`, `mkdir`, `move`, `trash`, `stale`, `extract` (another meaning).

## Nouns and terms

| Term | One meaning | Not | Used wrongly |
|---|---|---|---|
| store (local store) | the one SQLite database tg, max, memo and drive share on this machine | archive, cache, message database, shared store | memo help says "shared store"; drive help says "cached sources"; max keeps a per-profile **cache**, a different thing (STANDARD rule 7) |
| message | one post in a messenger chat, or one email | item, post (except a channel post), hit | none |
| attachment | a file of a stored message | file, media | max `chats media` (the messenger's media list: allowed as the messenger's word) |
| file text | the text read from an attachment and kept in the store, found by `content:` | extracted text, OCR text | `attachments text set` is the right place; no conflict found |
| transcript | the text of speech: a voice message or a meeting recording | — | tg/max `store export --format markdown` calls a day-by-day export "a transcript" |
| note | text the owner writes, or a file from a notes folder | memo, annotation, document | tg/max `contacts notes` are notes about a contact (same table, fine); drive help says "local shared memos about a source document" |
| document | a file imported from Google Drive or Docs | source, note | drive help says "imported sources" for documents; drive keeps documents as `note:` rows (`drive-cli/src/store.ts:111`), so one thing has two names |
| folder | **open (NEED-988)**: three different things share the word | — | tg `chats folders` (Telegram chat folders), memo `folders` (notes folders), drive `folders` (Google Drive folders chosen to sync) |
| tag | a label the owner puts on a thing; a `topic` is a tag kind only the owner makes | label | memo help says "labels" for tags; tg `tags auto` makes tags from rules |
| topic | **open (NEED-989)**: two meanings | — | tg `topics`, `search topics` (forum topics in a group); memo `vocabulary create` (a kind of tag) |
| project | the owner's work unit with a task key | entity | `entity:` references still parse for old files |
| organization | a company, team, family or community | entity | none |
| person | one human, across every messenger and mail (`person:<uid>`) | user, people | tg bot help: "user:<id> for a person", "the person's user id"; drive `people` |
| contact | one identity in a messenger's contact list | user | none found beyond the above |
| identity | one account of a person in one messenger or mailbox (`contact:<provider>/<id>`) | contact (when meaning the account), user | memo `note <identity>` takes `<messenger>:<name>` |
| key document | **open (NEED-990)**: no CLI, help text or doc defines it today | — | — |
| fact | what happened: a statement, question, decision or promise, with evidence | memory | none |
| memory | what an agent concluded, with evidence and scope | fact, summary | none |
| relationship | a confirmed or suggested link between a person, organization or project | relation, link | memo `tasks relations` (task to task); drive `links` (links between references) |
| reference | the typed name of any stored thing: `msg:`, `chat:`, `contact:`, `note:`, `document:`, `person:`, `task:`, `fact:`, `memory:` (`src/domain/references.ts`) | ref, id | see [Output keys](#output-keys) |
| locator | the reference of one message: `msg:<provider>/<account>/<chat>/<message>` only (`src/domain/locator.ts`) | ref | memo `search` puts `note:` and `task:` references in `locator` (`cli-memo/src/search/command.ts:82,123`) |
| profile | the name of one login of this CLI on this machine; chosen, never assumed | account (for this meaning) | memo `mail <account>`, `--account`; drive help "account profiles"; tg/max `contacts profile` (a person's card: another meaning) |
| account | the messenger or mail account behind a profile; also `provider/account` in the store key | profile | tg/max `account list` lists profiles |
| source | where stored data came from: a messenger, a mailbox, a notes folder, Google Drive | — | memo `tags add` "Put labels on one source" (means one stored thing); drive "imported sources" (means documents) |
| search hit | one result of a search | result, match, item | JSON key is `items` in some searches and `hits` in others; see below |
| context | **open (NEED-987)**: two meanings | — | entity card: memo `context`, `projects context`, `organizations context`, drive `documents context`, tg/max `contacts context`; messages around one message: tg/max `messages context` |

## Output keys

Read from source, not run.

| Kind | Canonical key | Deviations |
|---|---|---|
| A list | `{ items, page, limit, hasMore }` (STANDARD, Output rule 1) | `search notes` answers `{ query, by, hits, hasMore, nextOffset, linked }` (`src/cli/messenger/search-command.ts:196`, `src/services/notes-search.ts:232`); drive `search` the same (`drive-cli/src/store.ts:109`); drive lists answer `{ items }` alone (`drive-cli/src/program.ts:243,313`); memo and drive `commands --json` add `items` beside `commands` (`drive-cli/src/program.ts:527`) |
| A message | `locator` (`msg:` only) | none in tg/max |
| Any other stored thing | **open (NEED-986)**: `ref` or `reference` | `ref`: `search notes` hits, memo `tasks list` (`cli-memo/src/tasks/command.ts:171`), drive `documents show` (`drive-cli/src/program.ts:326`); `reference`: drive `documents list` (`drive-cli/src/program.ts:315`); `locator` holding a non-message: memo `search` |
| A command to run next | a field that names its purpose, such as `next` | `chats show` and the members audit answer `fetch: "<cli> store fetch <chat>"` (`src/services/chats.ts:269,310`): the key is a verb |
| A page cursor | `page` and `hasMore` | searches add `nextOffset`; MCP `search_notes` says it returns `hits` (`src/mcp/tools/search-tools.ts:152`) |

## Decided (owner, 2026-10-12)

- **`store fetch` becomes `messages sync`.** `sync` means "bring the local store up to date from
  the source, only what changed; `--all` for every chat or source". `memo import` becomes
  `memo sync`. drive `sync` already has this meaning: it keeps a change cursor and reads
  everything only on the first run. `fetch` stays for a bounded pull of one named thing
  (`chats members fetch`). STANDARD's verb list says so. The renames come in their own pull
  requests; the violation rows above change when they merge.

## Open questions for the owner

- **NEED-985 · May `store fetch` and `memo import` keep working for three releases after the
  rename, against STANDARD rule 9 ("No aliases")?** Proposed wording for rule 9: "`store fetch`
  and `memo import` keep working for three releases after their rename, hidden from help, print
  one line on stderr that names the new path, and then stop working. This is the only exception."
  Saved background jobs and `schedule command` records do not need it: they are rewritten to the
  new path when they run. What needs it: memo's installed timer (it runs `memo import`; without
  the old name it fails before it can rewrite its own unit, and with it the unit is rewritten to
  `memo sync` on its first run), hand-written scripts, and agents' skills such as tg-cli's
  `skills/tg-cli/SKILL.md`.
- **NEED-986 · A reference key:** `ref` or `reference` for a non-message thing? `ref` is shorter
  and used more; `reference` matches the domain type and the plain-word rule for options.
- **NEED-987 · `context`:** keep it for the entity card (memo, drive, `contacts context`) and
  rename `messages context` (for example `messages around`), or the reverse?
- **NEED-988 · `folders`:** three meanings (Telegram chat folders, notes folders, Drive folders).
  Keep `folders` for the messenger's and prefix the others (`notes folders`, `drive folders`), or
  accept one word per CLI?
- **NEED-989 · `topic`:** Telegram forum topics and memo's topic tags. Rename memo's kind (for
  example `subject`), or keep both?
- **NEED-990 · key document:** what does it mean, and which CLI has it?
- **NEED-991 · drive file verbs:** keep Google's `trash`, `mkdir`, `move`, `copy`, `get` (they
  mirror the Drive API), or map them to `delete`, `create`, `show`?
- **NEED-992 · One permission for syncing:** `messages sync` (like `store fetch` before it) is
  checked against the read key `messages`, but `--sync-first` on a search is the write key
  `messages.sync-first`. A read-only profile can sync directly but not through `--sync-first`.
  Make both reads, or both writes?
