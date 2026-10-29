# Glossary of command words and terms

One word, one meaning, in every WireCat CLI: tg, max, memo, drive and zm. This page lists the words for
commands, resources and JSON keys, the one meaning of each, the words it replaces, and where a CLI
uses it differently today.

- The [WireCat CLI standards handbook](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/README.md) binds all five CLIs. The verb, resource and flag
  meanings live in cli-base's vocabulary and are shown in [STANDARD.md's tables](STANDARD.md#vocabulary-and-lint-rules);
  this page repeats a word only to show where it applies and where it is broken.
- Each CLI starts from its own lint baseline (`lint/baseline/`), which only shrinks; each repository
  fixes its violations in its own change.
- A word changes in cli-base's vocabulary first, in its own pull request, and the owner approves new
  wording. This page follows.
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
| `show` | show one | all | `get`, `view` | tg/max `metadata show`, max `bot comments get`, drive `documents get`, `files get`, `comments get`, `permissions get`, `revisions get` |
| `search` | find by text, under `search <resource>` | all | `find`, `query` | drive `search` (root leaf, no resource), memo/drive `memories search` (a resource's own search leaf) |

| `create` / `delete` | make or destroy a thing | all | `mkdir`, `trash`, `rm` | drive `files mkdir`, `files trash` (see NEED-991) |
| `add` / `remove` | put an existing thing into a set, or take it out | all | `rm`, `attach` | tg/max `contacts aliases remove`; memo `folders attach` |
| `update` | change a thing's fields | all | `plan`, `edit` for fields | tg/max `tasks update` (sets title, due date) |
| `set` / `unset` | one named key | all | `configure` | drive `models configure` |
| `sync` | bring the local store up to date from the source: only what changed, or the whole list where the source cannot say; `--all` for every chat or source (owner, 2026-10-12); a mirror syncs both ways, as drive's `mirrors sync` (owner, 2026-10-24) | all | `import` for a catch-up, `refresh`, `store fetch` | memo `import` and `notes import` (to become `memo sync`), memo `mail <account> import`, tg/max `metadata sync`, `stats messages counters sync`; tg/max `contacts sync` help says "forget where the last sync left off and take the whole list again" — its help still describes a full re-read of the list, not only what changed |
| `fetch` | one bounded pull of one named thing from the messenger, not a catch-up | tg, max | `refresh`, `get` | `--refresh` options (`contacts context`, `search conversations`) |
| `import` | bring a file or list the user gives into the store or the messenger, once | all | — | memo `import`, `notes import` (a repeatable catch-up: `sync`) |
| `export` | write from the store to a file | all | — | none |
| `extract` | read the text inside files already on this machine into the store | tg, max | — | drive `memories extract` (sends text to a model and proposes memories: another meaning) |
| `link` / `unlink` | record that two identities are one person, or undo it | tg, max | — | `tasks link` (a task and what it concerns; with a `task:` target, task to task), memo `projects meetings link`, drive `people link` (a Google user to a person); tg/max `messages link` (a view: the permalink) |
| `confirm` | the owner accepts what an agent proposed | memo, drive | `accept`, `approve` | memo `facts accept`, `actions approve` vs `relationships confirm`, `memories confirm` (three words, one meaning) |
| `reject` | the owner refuses what an agent proposed | memo | `decline`, `deny` | none in memo; tg/max `chats requests reject`, `replies consents deny` are the messenger's own words |
| `start` / `stop` | a running process or a login session | all | `on` / `off`, `enable` | tg/max `replies on` / `off`, memo `auto on` / `off`, tg `topics enable` |
| `pause` / `resume` | stop and restart what a running process does, without stopping it | tg, max | `snooze` for a process | none |
| `check` | verify, change nothing | tg, max | `audit`, `preflight` | tg/max `chats members check`, memo `vocabulary audit`, `vocabulary preflight` |
| `cancel` | stop a job or a pending thing | all | — | none |
| `status` | how a thing stands right now | all | `readiness` | memo `tasks readiness` |
| `info` | facts about a singular thing itself | tg, max | — | none |
| `move` / `copy` | a file in the source | drive | — | none |
| `restore` | put a backup back, or take a thing out of the trash | tg, max, drive | — | drive `files restore` (out of the trash: a second meaning) |
| `rebuild` | compute again, from what the store holds, what the tool derives from it, keeping the owner's decisions | tg, max | — | none; tg/max `store rebuild` is not in the vocabulary |

Verbs used but not in cli-base's vocabulary, by CLI (2026-10-12). Each needs a registry entry or a rename.

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
| store (local store) | the one SQLite database tg, max, memo and drive share on this machine | archive, cache, message database, shared store | memo help says "shared store"; drive help says "cached sources"; max keeps a per-profile **cache**, a different thing ([STANDARD.md, Messenger words](STANDARD.md#messenger-words)) |
| message | one post in a messenger chat, or one email | item, post (except a channel post), hit | none |
| attachment | a file of a stored message | file, media | max `chats media` (the messenger's media list: allowed as the messenger's word) |
| file text | the text read from an attachment and kept in the store, found by `content:` | extracted text, OCR text | `attachments update` is the right place; no conflict found |
| transcript | the text of speech: a voice message or a meeting recording | — | tg/max `store export --format markdown` calls a day-by-day export "a transcript" |
| note | text the owner writes, or a file from a notes folder | memo, annotation, document | tg/max `contacts notes` are notes about a contact (same table, fine); drive help says "local shared memos about a source document" |
| document | a file imported from Google Drive or Docs | source, note | drive help says "imported sources" for documents; drive keeps documents as `note:` rows (`drive-cli/src/store.ts:111`), so one thing has two names |
| folder | **open (NEED-988)**: three different things share the word | — | tg `chats folders` (Telegram chat folders), memo `folders` (notes folders), drive `folders` (Google Drive folders chosen to sync) |
| tag | a label the owner puts on a thing; a `topic` is a tag kind only the owner makes | label | memo help says "labels" for tags; tg `tags rebuild` makes tags from rules |
| topic | forum topics in a group: `topics`, `search topics` (cli-base vocabulary) | — | memo `vocabulary create` (a kind of tag) |
| project | the owner's work unit with a task key | entity | `entity:` references still parse for old files |
| organization | a company, team, family or community | entity | none |
| person | one human, across every messenger and mail (`person:<uid>`) | user, people | tg bot help: "user:<id> for a person", "the person's user id"; drive `people` |
| contact | one person as one source knows them: a mail correspondent, a Telegram user, a Drive owner, a calendar attendee; an `identities` row | user | none found beyond the above |
| entity | the thing the owner means — a person, an event, a document; it carries no provider id ([WC-DATA-2](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/data-model.md)) | record, object | none |
| source record | one source's copy of an entity, keyed by account and `external_id`: a contact, a Zoom meeting, an email, a message | entity, item | none |
| core entity | an entity or source record whose table cli-core owns because more than one tool needs it | shared table | none |
| preferred source record | the copy whose fields an entity shows, chosen by a rule per entity | primary, main copy | none |
| provider registry | the providers this store knows: the built-ins plus what each CLI wrote with `registerProvider` | provider list | none |
| review list | pairs that may be one thing, kept for the owner to decide instead of linked by a rule (not built yet) | duplicates, merge queue | none |
| identity | one way to reach a person or an organization: an account in a messenger or mailbox, an e-mail address, a phone (`contact:<provider>/<id>`) | contact (when meaning the account), user | memo `note <identity>` takes `<messenger>:<name>` |
| key document | **open (NEED-990)**: no CLI, help text or doc defines it today | — | — |
| fact | what happened: a statement, question, decision or promise, with evidence | memory | none |
| memory | what an agent concluded, with evidence and scope | fact, summary | none |
| relationship | a confirmed or suggested link between a person, organization or project | relation, link | memo `tasks relations` (task to task); drive `links` (links between references) |
| mention | a phone, e-mail address, link, document or known person's name found in one place of a stored text, normalized; found → linked or dismissed | extraction, entity, link (`links` joins two stored records) | none |
| reference | the typed name of any stored thing: `msg:`, `chat:`, `contact:`, `note:`, `document:`, `person:`, `task:`, `fact:`, `memory:` (`src/domain/references.ts`) | ref, id | see [Output keys](#output-keys) |
| locator | the reference of one message: `msg:<provider>/<account>/<chat>/<message>` only (`src/domain/locator.ts`) | ref | memo `search` puts `note:` and `task:` references in `locator` (`cli-memo/src/search/command.ts:82,123`) |
| profile | the name of one login of this CLI on this machine; chosen, never assumed | account (for this meaning) | memo `mail <account>`, `--account`; drive help "account profiles"; tg/max `contacts show` (a person's card: another meaning) |
| account | the messenger or mail account behind a profile; also `provider/account` in the store key | profile | tg/max `account list` lists profiles |
| source | where stored data came from: a messenger, a mailbox, a notes folder, Google Drive | — | memo `tags add` "Put labels on one source" (means one stored thing); drive "imported sources" (means documents) |
| search hit | one result of a search | result, match, item | JSON key is `items` in some searches and `hits` in others; see below |
| context | **open (NEED-987)**: two meanings | — | entity card: memo `context`, `projects context`, `organizations context`, drive `documents context`, tg/max `contacts context`; messages around one message: tg/max `messages context` |

## Output keys

Read from source, not run.

| Kind | Canonical key | Deviations |
|---|---|---|
| A list | `{ items, page, next?, missing?, meta }` ([WC-OUT-4](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/output.md#wc-out-4--answer-every-json-request-with-one-envelope-a-list-or-one-thing)) | drive `search` answers `{ query, by, hits, hasMore, nextOffset, linked }` (`drive-cli/src/store.ts:109`); drive lists answer `{ items }` alone (`drive-cli/src/program.ts:243,313`); memo and drive `commands --json` add `items` beside `commands` (`drive-cli/src/program.ts:527`) |
| A message | `locator` (`msg:` only) | none in tg/max |
| Any other stored thing | `ref` ([WC-OUT-13](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/output.md#wc-out-13--write-times-durations-references-and-empty-values-one-way)) | `reference`: drive `documents list` (`drive-cli/src/program.ts:315`); `locator` holding a non-message: memo `search` |
| A command to run next | a field that names its purpose, such as `next` | `chats show` and the members audit answer `fetch: "<cli> messages sync <chat>"` (`src/services/chats.ts:251,292`): the key is a verb |
| A page cursor | `page.has_more`, with `page.next_page` or `page.next_cursor` ([WC-OUT-5](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/output.md#wc-out-5--say-in-page-how-the-source-pages)) | none in tg/max |

## Decided (owner, 2026-10-12)

- **`store fetch` becomes `messages sync`.** `sync` means "bring the local store up to date from
  the source, only what changed; `--all` for every chat or source". `memo import` becomes
  `memo sync`. drive `sync` already has this meaning: it keeps a change cursor and reads
  everything only on the first run. `fetch` stays for a bounded pull of one named thing
  (`chats members fetch`). cli-base's vocabulary says so. tg and max have renamed `store fetch`;
  memo's `import` rows above were read on 2026-10-12.

## Decided by the cli-base registries and the handbook

- **NEED-985 · No alias for a renamed path**, `store fetch` and `memo import` included: a renamed path stops
  working in the release that renames it ([WC-CMD-8](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-8--keep-no-aliases-a-renamed-path-stops-working-in-the-release-that-renames-it)).
- **NEED-986 · A stored thing is named by `ref`** ([WC-OUT-13](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/output.md#wc-out-13--write-times-durations-references-and-empty-values-one-way)).
- **NEED-989 · `topics` are forum topics in a group**, in cli-base's vocabulary. memo's topic tags need another word.
- **NEED-991 · drive's file verbs map to the vocabulary:** `delete` replaces `trash` and `rm`, `create` replaces
  `mkdir`, `show` replaces `get`; `move` and `copy` are registered verbs for a file in the source.

## Open questions for the owner

- **NEED-987 · `context`:** keep it for the entity card (memo, drive, `contacts context`) and
  rename `messages context` (for example `messages around`), or the reverse?
- **NEED-988 · `folders`:** three meanings (Telegram chat folders, notes folders, Drive folders).
  Keep `folders` for the messenger's and prefix the others (`notes folders`, `drive folders`), or
  accept one word per CLI?
- **NEED-990 · key document:** what does it mean, and which CLI has it?
- **NEED-992 · One permission for syncing:** `messages sync` (like `store fetch` before it) is
  checked against the read key `messages`, but `--sync-first` on a search is the write key
  `messages.sync-first`. A read-only profile can sync directly but not through `--sync-first`.
  Make both reads, or both writes?
