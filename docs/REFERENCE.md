# API reference

The detailed contract of each entry point, for consumers and contributors. The [README](../README.md)
explains what the package is and how it is built; this page is what to call.

## Native recording partials

`NativeRecordingPartialStore` from `./persistence/native` implements the existing meeting transfer
storage port with bounded metadata, exact-prefix verification and owned native handles. The host
supplies its dotfile prefix, persistence choice and byte limit. See the
[native adapter guide](dev/NATIVE-RECORDING-PARTIALS.md) for ownership, compatibility and cleanup.

`NativeRecordingPublication` shares bounded journal I/O, no-overwrite final linking and verified
interruption recovery. Hosts keep their own manifest codec and durable commitment callback; see
the [publication guide](dev/NATIVE-RECORDING-PUBLICATION.md).

## Retained meeting references

`parseMeetingReference`, `formatMeetingReference` and `canonicalMeetingReference` name local meeting
records as `meeting:<accountId>/<meetingId>`, a retained transcript revision with `/<transcriptId>`,
and one cue with `/<cuePosition>`. IDs are positive safe integers; cue positions start at zero.
These references stay within one store and retain the exact revision after a correction.
They use a dedicated parser; the general `parseReference` and existing knowledge targets do not
accept them yet. A reader must verify the caller's authorized account before returning content.

## Canonical project and label vocabulary

### Reviewing duplicate tags

The [tag consolidation foundation](dev/TAG-CONSOLIDATION.md) documents the separate bounded
`createTagRedirectIndex` policy and compatibility requirements. It does not enable store merges.

`store.knowledge.previewTagConsolidation({ sourceId, survivorId,
expectedVocabularyFingerprint, maxRows?, maxReadBytes?, sampleLimit?, signal? })` reads two explicit
canonical tag IDs. Obtain the required fingerprint from unfiltered `vocabulary()`; filtered catalog
fingerprints, topics, self-selection, missing IDs, stale vocabulary and unknown fields are refused.
Names and lexical similarity do not select a survivor. The method reads one SQLite snapshot and works
on a query-only connection without schema changes, index maintenance or model calls.

The preview counts each tag's assignments by target type and shared targets, aliases, automatic
claims and shared chats, plus links in either direction. Bounded samples retain assignment source
and author IDs; claim fields and link evidence/metadata are fingerprinted without being returned.
`previewFingerprint` covers the directional selection, vocabulary fingerprint and every inspected
row, including provenance. Changing a sample limit does not change it. It is not an authorization
token or a fingerprint for a future apply operation.

Defaults are 5,000 dependency rows, 1 MiB of dependency input and 10 samples per sampled table;
ceilings are 20,000 rows, 16 MiB and 100 samples. A conservative SQL byte estimate rejects oversized
rows before hydration, so a preview can refuse before the actual JSON byte limit is reached. The
catalog has its own existing limits. Exceeding either dependency budget fails the whole preview.
`coverage.samplesComplete` reports sample truncation; counts and the fingerprint still cover every
selected dependency row. `coverage.completeWithinInspectedTables` covers only `taggings`, `aliases`,
`auto_tag_claims` and `links` referencing the selected tags. It does not cover saved search text,
proposal/action history or arbitrary serialized references; `coverage.applySupported` is always
false. No consolidation command or write is provided by this SDK slice. Applying consolidation
requires a separate canonical-reference/provenance contract that also accounts for those references.

### Catalog, resolution and aliases

`store.knowledge.vocabulary({ kind?, scope?, maxEntries?, maxReadBytes?, signal? })` lists live owner
projects and tags/topics with stable IDs, aliases, usage counts and a preview fingerprint.
`resolveVocabulary(name, options)` matches only explicit aliases, canonical names or project keys;
several matches remain ambiguous. Unicode normalization preserves accents and distinct letters.
Person/contact aliases are independent and retain their existing behavior.

`addVocabularyAlias({ kind, id }, name, { expectedFingerprint?, by?, signal? })` and
`removeVocabularyAlias(target, aliasId, options)` are owner writes with transactional collision and
stale-preview checks. Creating a project cannot shadow an existing project alias. Knowledge labels,
main-topic selection and label filters resolve an exact tag/topic alias to its canonical name.

`tagPreflight(name, { kind?, maxEntries?, maxReadBytes?, signal? })` returns `reuse`, `create` or
`review`, with lexical candidates and a vocabulary fingerprint. Its separate `creationFingerprint`
binds owner approval to the requested name, kind and current label/alias metadata. Similarity suggests
review; it never selects a synonym, changes a tag or loads a model.

Every native new-label path checks tags, topics and their aliases before insertion, including implicit
knowledge labels, note-file imports and automatic chat tagging. A lexical score of at least 0.65
refuses creation with `tag_review_required` and up to ten candidates. The whole enclosing write rolls
back. Existing exact names and explicit aliases still reuse their canonical label.

Reuse an existing label or add an owner-reviewed alias when the names mean the same thing. For a
purposefully distinct label, call `createTag(name, { kind?, expectedCreationFingerprint })` with the
current preflight receipt. This owner-only acceptance is checked under the write lock and refuses
stale or differently targeted receipts. There is no force bypass. The creation check bounds input to
5,000 labels, 100,000 aliases and 4 MiB of names, and fails before hydration if those limits are exceeded.
`auditVocabulary({ kind?, scope?, minSimilarity?, maxComparisons?, limit?, maxEntries?, maxReadBytes?, signal? })`
reports pairs of distinct canonical records with lexical similarity. It compares projects with projects,
and tags/topics with labels, including explicit aliases. Defaults are similarity 0.65, 10,000 name
comparisons and 20 pairs; maximums are 100,000 comparisons and 200 pairs. `complete: false` means a
budget stopped the scan, not that remaining names are unique. The fingerprint identifies the reviewed
catalog. Names in output are capped at 300 characters with an explicit truncation flag. This read does
not accept a synonym, mutate tags or load a model. Semantic detection and reviewed merges remain separate work.

## Meeting-project membership

`store.knowledge.linkMeetingProject(account, meetingId, projectId, options)` records one `member-of`
link in the shared relationship table. Meetings are checked against the explicit provider/account;
projects must be live owner projects. `by: "agent"` creates a proposed link; it cannot confirm one.
An owner accepts a proposal by passing its `expectedFingerprint`, preserving its recorded provenance.
Replaying an existing link returns `changed: false`; stale review fails before writing.

`meetingProjects(account, { meetingId?, projectId?, confirmed?, limit?, offset?, signal? })` lists
membership in that account, with canonical references and fingerprints. Reads take at most 500 rows
and 2000 provenance characters per row; deleted/foreign meetings and deleted/account projects are
excluded. Title/alias similarity never creates membership. These are shared store APIs; a command
surface and project-selected transcript retrieval are separate consumer work.

## Project task keys and dependencies

New owner projects receive a 3–4-character uppercase key, or take an explicit key of that shape.
Existing keys stay stable. Task creation allocates `<project key>-<number>` inside a write transaction;
a failed creation rolls back the counter. No project or task is renumbered.

A task found in a message takes a key by its type instead — `Q-n` question, `REQ-n` request, `M-n` mention,
`PR-n` promise — from a counter per type (`task_key_counters`) taken in the same write as the insert. Tasks made
before store version 13 keep their inbox key (`IN1A2B3C4D-17`); either key and the task's id resolve. `REQ` is
kept from new project keys. `store.tasks.claim(id, holder, until)` takes an open task in one `UPDATE … RETURNING`
under the write lock and refuses, naming the holder, while an unlapsed claim holds it; `release` and closing the
task clear it.

`store.tasks.linkTask(from, to, kind, "owner")` and `unlinkTask` manage `blocked-by`, `follow-up-of`,
`related-to`, `duplicate-of` and `discovered-from`. `RES-2 blocked-by RES-1` means RES-1 must finish first. Informational follow-up and
related links do not affect readiness; related pairs are symmetric. Cycles and self-links fail before
writing, replays return `changed: false`, and actual changes append linked/unlinked task events.
Agents propose changes for owner review. Targets must be live tasks in owner projects; inbox tasks
need their separate account-scoped service, except `duplicate-of`, which joins any two live tasks of one project or
account. Parent hierarchy remains a separate field.

`store.tasks.compare(subject, other)` scores one pair as `similar` scores a candidate. `task_pairs` (store version
15) keeps each pair that may be one job and what was decided: `reviewDuplicates(task)` puts a rule-made task's likely
and maybe candidates on the review list (a rule never merges); `pairs(account, { decision })` reads it;
`decidePair(task, other, "rejected" | "unsure", by)`, `merge(dup, into, by)` and `unmerge(dup, by)` decide. A merge
links every message of the duplicate to the task as `evidence`, closes it `dismissed` with a `duplicate-of` relation
and deletes nothing; the reviewing agent may merge, so these take any author. `findBySource(account, source,
{ linked: true })` also finds the task a message was attached or merged into, so a rule opens no second one.

`taskRelations(id)`, `taskReadiness(id)` and `readyTasks(project, { limit? })` read bounded coherent
snapshots. Only a done blocker is resolved: dismissed/deleted blockers continue to require review.
Ready reads are discovery, not a work claim or exclusive lock. SQLite write transactions serialize
counter/dependency mutations; expiring agent leases and command mounting are subsequent work.

## The rule this package keeps

**Nothing here knows a messenger.** An adapter translates its provider's objects into these types,
and a lint rule refuses any import of a messenger library or an adapter under `src/`. What only one
provider has travels in `providerMetadata`.

| | |
|---|---|
| `.` | `Chat`, `Message`, `Contact`, `Page`… · `formatLocator` / `parseLocator` · `renderMessages` · `pickChat` / `pickPerson` · `parseMarkdownSpans` (Markdown into text and neutral spans; each messenger renders them) |
| `./charts` | neutral chart data, a replaceable renderer interface and on-demand dark SVG and PNG images |
| `./models` | `modelGateway`, provider-neutral requests, adapter-owned option checks, injected keys and purpose consent, and `modelTarget` for effective configuration; [provider settings](search/ai-providers.md) |
| `./store` | `openCache` — `node:sqlite` under Node, `bun:sqlite` under Bun, WAL and a busy timeout on both · `openStore` — the shared message store, every method async: one file for every messenger (`wirecat.db` in `~/.local/share/WireCat/`, `%LOCALAPPDATA%\WireCat\Data\` on Windows; `MESSAGING_STORE` overrides where), forward-only migrations with `min_compatible`, every sender an identity with a person of their own, edits kept as revisions, a message by its id, deletions kept as tombstones, trigram search · `find` — by text, by sender, or both; `together` for the chats where every sender wrote, `perChat` to cap each chat · `savePeople` and `people` — usernames, bot flags and an `email` that joins the mail contact of that exact address, and a `PeopleLookup` for `pickPerson` |
| `./sends` | the send guard: a level per command path (`permissions`: deny, readonly, ask, allow), a recipient list, an hourly limit, and a journal of every attempt that never holds the text; `guardFor(app, settings, warn, env?, ask?)` builds it from a profile's settings, and `settings.permissionDefaults` gives a CLI's own defaults (`commandPermissions`) in place of the messenger's; `newSendId` for a send's identity across retries |
| `./cli` | the command skeleton: `run` (never throws, returns an exit code), the global flags, `settingsFor` (flag → environment → file → default, one strict file schema with each CLI's own fields), the profile as the first word, `--timeout` that closes what a command holds, paging, and run records: a run is kept by default (`record: false` keeps failures only, `--no-record` nothing) with its ids and timings, the command line as typed with any secret masked (a value of an option or argument marked `secretInput`, one named for a token, password or key, a URL's password, a long opaque string; `record_input: false` in the config masks every value that may be content, as before), the coding agent and its session (a command a CLI records itself with `recorded` or `startRecording` gets the same by passing `context: runContextOf({ bin, command, program, argv, env, recordInput })`), and for a failure its class, masked message, HTTP call or protocol refusal, causes and frames (never content), and `runsCommand` gives `runs list\|show\|path` · `configCommand(app, config)` shows and changes the settings with where each came from · `settingsFor(app, { permissions: commandPermissions({ extra, defaults }) })` gives a CLI that is not a messenger the shared `permissions`, keyed by its own command paths (`commandPathKey`): `config set`, an MCP server's `--permission` and the check before each command take those keys and refuse any other · `completeCommand(messenger, config, options?)` gives shell completion, account-scoped chat and person ids from the store and never a connection; `options.sources` can supply local suggestions for a separate command group and `options.account` can read an existing local account binding · `providerLogPathFor(app, profile, env)` and `openProviderLog(path)` give a profile's always-on warning log of the messenger library (`<state>/provider-log/<profile>.jsonl`, mode 600, 1 MB and one older file), which an engine in another process appends to as zerolog JSON lines with an optional `kind`; `writeProviderWarning(path, kind, message)` appends from Node; the adapter masks every phone number, id of a person and text first · `buildDoctorReport` and `doctorReportFileName` let a consumer retain its own doctor projection while sharing run selection, identifier labelling and home-path redaction; the run's typed words are masked as `record_input: false` would, read against `program` when one is passed; optional technical context is redacted too · `storeSummary(env)` gives its local store diagnostics to consumers retaining their own doctor command · `storeInfo(env)`, `storeInfoCommand()` and `sharedStoreCommand()` give any tool `store info`: the shared store read-only, its schema against the one this tool speaks (`reason`, and `upgrade` — what this tool's next run raises it to) and the tools that used it · `checkConfigText(text, { file, tool, schema, knownPermissions? })` turns a config file's text, flat or with profiles, into the `ConfigIssue[]` `doctor` reports and what of it still loads; `unknownPermissionIssues(command, settings, tool, keyOf?)` lists the permission keys saved anywhere in the file that no command checks; `refuseUnknownPermissionKeys(command, settings, tool, keyOf?)` refuses such a key, or a `--permission` key no command checks, for a command the shared check does not key (`api call`, `mcp`); `terminalAsker(command)` is the guard's `ask` for a command a person typed: `--yes` (or `--allow-dangerous`) goes ahead, a terminal asks, and under `--json` or with nobody there it refuses with `confirmation_required`; `issueMessage(issues, doctor?)` is the one-line refusal a command gives on such a file · `readConfigText(path)` and `readConfigFile(path)` read a config file, and give no text for no file but an issue for a folder or a file that cannot be read · `withoutSetting(raw, setting)` removes one setting at any depth, list items included (`mail.accounts.0.colour`), for a tool's own `config unset`; `settingPathOf(setting)` is the path it removes · `doctorCommand(messenger)` reports the installation's state from disk (the config file's problems as `config.issues`, each with the `config unset` that removes it; the store, the account, sends, runs, the messenger library's warnings of the last day by kind (`provider_log`), the messenger's own checks), and connects only with `--online`; `doctor reports create` writes that, the failed run and the recent sends to a file with every id a label · `appMcpCommand(app, configuration, { name, untrusted, permissionExample })` gives a CLI that is not a messenger the same `mcp` group as `mcpCommand` (serve, revoke, server, config, add, check; `--profiles`, `--http`, `--permission`), serving its own program's commands, and `appDoctorCommand(app, configuration, { oauthClient, packageName, online })` its `doctor`, from disk unless `--online`: paths, store, OAuth client, read-only and profile locks, config issues; `--online` adds `online` — the `online` hook's own check of the service and, with `packageName`, whether npm has a newer version · `skillCommand(app, url)` prints the CLI's own SKILL.md for an agent (`skill show`) · `commandsCommand(app)` describes every command as JSON, with `contract` (`CONTRACT`, the major version of the output types) and which commands write · the shared read commands: a CLI describes its messenger once (`Messenger`: its app, a `connect` that returns a `MessengerAdapter`, how `me` maps to a chat) and gets `accountCommand`, `chatsCommand` (`list`, `show`), `contactsCommand` (`list`, `show`) `recipientsCommand`, `sendsCommand`, `watchCommand` (new messages as they arrive, `--jsonl`, until Ctrl-C or `--timeout`; `--events` adds edits, deletions, reactions, poll votes, stars and chat events, each kept in the store), `storeCommand` (the local store: `messages sync` (mounted under `messages`) puts a chat's history into it, resumable, FloodWait-aware, with `--json` a `progress` line of counts on stderr per chat (`--all`) or per page, `--since` to stop at a time, `--background` for a detached job that `store jobs list|show|cancel` follow, `--dry-run` to only price what is left from the store alone; `store status` what it holds; `store export` a chat's messages out of it, as JSON or `--format markdown`; `store clear --left` deletes the chats the account has left, naming them first (`--dry-run` lists them all); `store tables list` names every table with its kind and rows (`--full` adds sizes); `store info`, `store check`, `store migrate`, `store backup` and `store restore` look after the file itself — its size, schema, migrations and last backup, whether it is healthy and which chats are behind, bringing it up to this build, and a copy to go back to), `inboxCommand` (other people's unread messages in every chat, or with `--new` what arrived since the last check — each message once, the point moved only by a run that printed; copied from max-cli), `serveCommand` (keeps the store current until stopped — one per profile by a lock file, catch-up on, started by a person, `server start` or a unit; for a messenger with `connection: "exclusive"` it also runs every command that reaches the messenger on its own connection — [the serve relay](dev/ARCHITECTURE.md#the-serve-relay)), `serverCommand` (`server start|stop|restart|status|logs`: `serve` in the background, as max-cli's `server`; `install|uninstall` add a systemd user unit or a launchd agent per profile, and `install` starts nothing), and `messagesCommand` (`list`, `show`, `context`, `search` over the store in the Lucene query language, `send` through the send guard (`--reply-to`, `--silent`, `--no-preview`, `--md`, `--file` and `--photo` with the text as the caption, and `--at` to send later, with `scheduled` listing the queue), `edit` of the owner's own message, `forward` to another chat and `pin`/`unpin` through it too (the adapter's optional `edit`, `forward`, `pin` and `unpin`), and `delete` — at most 10, for the owner unless `--for-everyone`; it asks first by default, and `--allow-dangerous` is the yes · `reactionsCommand` (`add`, `remove`: the owner's reaction on a message, through the guard; the adapter's optional `react`) · `pollsCommand` (`show` a poll with its answer ids, `vote` by id or `--retract`, `close` the owner's own (hidden by `pollClose: false`), `create` one — a vote guarded as a reaction, closing as an edit, a new poll as a message with a send id); a `msg:` locator names a message) — every read saved to the store, `--offline` answered from it, each call a run event · `mcpCommand(messenger)` gives the `mcp` group; its `mcp serve` serves the profile to an agent over MCP on stdin and stdout with three tools: `<cli>_tools_search` finds a command and its arguments, `<cli>_read` runs a command that only reads, or only fetches from the provider into the store (`fetchesOnly`), and `<cli>_write` one that changes something, plus `status`, which names the profile and login without connecting. It holds one connection for minutes and runs one call at a time. A command is found and run by the profile's `permissions` and goes through the same guard as on the command line; a write at level `ask` acts without a form, retired confirmation flags only warn, and `messages delete` never deletes for everyone ([MCP rules](dev/STANDARD.md#mcp)), and `mcp config` prints the entry for a desktop client · `mcp serve --http` serves the same tools over HTTP on 127.0.0.1 behind the owner's tunnel with a one-owner login; `mcp revoke` forgets every login it gave; `mcp server start|stop|status` runs it in the background and reports its port, address, login code and the apps logged in; a CLI with its own MCP server mounts `serveOverHttp(build, options)` with `httpServerOptions(mode)`, `httpTokenFile` and `revokeAll`, and `mcpServerCommand(options)` with `lockFile: httpLockFile(tokenFile)` passed to `serveOverHttp` and `permission: true` when the CLI's `mcp serve` takes `--permission` (only then does `mcp server start` take it) (`OVER_HTTP` follows the same profile permission policy) |
| `./cli/start` | `startCli` alone, for a CLI's bin: crash catch, cancellation, the first-run questions and the consent prompt, without the command tree. A bare `--version` or `-V` is answered from `app.version` before the program loads; anything else on the line goes to the program |
| `./testing` | the adapter kit — **not stable yet**, so it may change in any release: `fakeAdapter(seed)`, a messenger in memory with every method group, for command tests; `contractCases({ connect })`, the port's promises as cases any test runner runs over an adapter; `contractSeed`, the chats and messages they read; `mcpOverStdio(start)`, a CLI's `mcp serve` driven over stdin and stdout through its `run()`. How to write an adapter and run them: [the adapter guide](dev/ADAPTERS.md) |
| `./tasks`, `./tasks/testing` | what waits on the owner: the task model, `TaskStore` and the service over it; the testing entry adds a memory store. Was `@wirecat/cli-tasks` |
| `./meetings` (`/cli`, `/mcp`, `/testing`) | events and meetings: the model, the WebVTT parser, the `MeetingSource` port a provider implements, `MeetingStore`, pull and import, the meeting commands and MCP reads; the testing entry adds a memory store, a fake source and the contract cases. Was `@wirecat/cli-meetings` — see [Meetings](dev/MEETINGS.md) |
| `./calendar` (`/cli`, `/mcp`, `/testing`) | calendars of any provider: the `CalendarSource` port an adapter implements (traits `expands`, `cursorHoldsWindow`, `fullListOnly`; a dead cursor answers `{ reset: true }`), the `EventStore` types (also in `./meetings`) and `syncCalendars`, which lists the calendars, reads each synced calendar's changes since its cursor or its whole window (a year back, three months ahead), asks for or expands the slots of series, and saves the cursor last; `addCalendarCommands` and `calendarTools` give the shared read-only commands and MCP tools; the testing entry adds `fakeCalendarSource`, `memoryEventStore`, `calendarSourceContract` for an adapter and `calendarSyncContract` for a store, over every trait combination — see [Calendars](dev/CALENDARS.md) |

⚠ **Errors are recognised by shape, not by class** (`isCliFailure`). A package linked during
development brings its own copy of cli-base, and an error built by one copy is not an `instanceof`
the other's class.

Field selection uses cli-base's `fieldsOf` and `projectFields`. Dotted paths traverse nested
objects and arrays; `items.ref` selects each list row's reference. Item/list envelopes, coverage,
continuation, missing data and execution metadata and operation identifiers stay intact. Parent
selections retain entire subtrees. Empty, invalid or unsafe paths are rejected before projection.
The runtime peer requires cli-base 0.35.0 or newer within the 0.35 series.

`addMeetingBatchCommand` (`./cli`) composes the registered word-search and passage grammars over
`MeetingBatchReader` (`./meetings`). `createMeetingBatchReader` (`./services`) fixes the existing
store operations to one account. The host supplies bounded file/stdin input, cancellation and
close-before-output rendering; Base supplies correlation, budgets and serial execution. See
[bounded read batches](dev/STANDARD.md#bounded-read-batches) for caps and partial-result semantics.

`searchAll` and the two below take the messenger as `{ app, savedChatId?, hintCommand? }`: `hintCommand` is the tool a
missing-model hint names when it is not `app.command`, and `null` names the tools with a `models` command — for a tool
like memo that borrows tg's identity for `group:` lists.

`searchAllIncludingMeetings` from `./services` adds one selected meeting account to the existing
message, mail and notes search. It leaves `searchAll` and its item references unchanged. The CLI
reaches it with `search all <query> --source zoom:<account>` (or `zoom`, `meetings`, `all`) and MCP with
`search_all`'s `source`; a bare word takes the one account that holds meetings and refuses when several do.
Choose another meeting account explicitly:

```ts
const found = await searchAllIncludingMeetings(store, account, {
  text: "project AND plan",
  limit: 20,
  meetingAccount: { provider: "zoom", account: "zm-profile:example" },
  maxMeetings: 100,
})
```

Meeting hits have `kind: "meeting"`, `accountId`, `meetingId`, `scope`, `id` and `startMs`, with no
canonical `ref`. They contain text previews of at most 2000 characters; their meeting timestamp can
be null. The existing unified ranking and the meeting list are blended by reciprocal rank. Meeting
order follows newest meeting first, then stored hit order; it does not claim a relevance score.

Meetings support letter/digit words joined by AND, including adjacent words, as word prefixes.
Exact forms, phrases, OR/NOT, patterns and field/date filters skip only meetings with a reason.
The meeting account defaults to `account` and is looked up without registration. Search reads
current transcripts, chat and summaries and excludes deleted meetings.

`maxMeetings` limits visited candidate meetings (1–1000, default 100), while `limit` bounds returned
items (1–1000). The store can allocate many hit rows within one candidate meeting; this service
cannot promise a hard query memory bound. `hasMore: null` means the scan stopped before proving
whether another match exists. `meetings.complete` describes the selected source's scan, and
`meetings.nextCursor` resumes with `only: ["meetings"]`, the same query and the same account. It
retains unreturned hits even when another resource filled the result limit. This is a meeting source
continuation, not a global cursor or a snapshot; changing archive contents can require restarting.


A **message locator** names one message across every provider and account:
`msg:telegram/<account>/<chat>/<message>`. A message id alone does not — Telegram numbers messages
per chat in channels and per account in private chats.

Forum addressing is an optional adapter capability: `messages send --topic` and `polls create --topic`
pass `threadId` through the shared service/guard. `validateThread` checks the topic and any reply
before sending, after the permission gate. Telegram group forums support it; MAX refuses it.
Journal records carry only the thread id. A retry keeps the same send id, chat and topic; scheduled
sends must be checked in the queue instead of repeated.

A CLI serves MCP by mounting `mcpCommand(messenger)`; what differs per messenger is on the `Messenger`
(`topics`, `skill`, `diagnose`, the `guard` hook). The server mounts one strict catalogue: unknown arguments fail
before execution.

## Media options

`messages send --spoiler` hides a photo or video until tapped, and `--caption-above` shows the text above the
attachment (send tool: `spoiler`, `caption_above`). A messenger offers them through `Messenger.mediaOptions`;
where it is unset the service refuses them before connecting, so an adapter that does not know an option never
receives one to drop. Both need an attachment. Per-message forward protection is left out: Telegram grants it
to bots only, and a personal account protects a whole chat instead.

## Sender identities

`chats send-as <chat>` lists who the account may post as in a chat: `{ id, title, kind, premiumRequired,
default }`, `kind` being `self`, `channel` or `group`. The personal identity is always in the list, and
`default` marks the chat's saved choice. Reading it changes nothing — the saved choice stays as it is.
`messages send`, `messages forward` and `polls create` take `--send-as <id>` (their tools `send_as`): the
service lists the identities of the chat the message lands in, in the same connection, and refuses an id
that is not there. An adapter without the optional `sendAsIdentities` refuses the option — it is never
dropped, and never falls back to the personal identity. Without `--send-as`, a chat whose saved sender is not
the account (the adapter's `savedSender`, say a group that posts as a linked channel) is refused before
sending: the messenger would post as that sender, and nothing typed said so. The refusal names both ids. The journal records the identity, and a retry of an
unknown send under the same send id must name the same identity.

## Message permalinks

The personal `messages link <chat> <message>` command also accepts a `msg:` locator.
Its read-only MCP tool and CLI call the same service and return `{ locator, url, access, reason }`.
Adapters can implement optional `permalink` to return HTTPS links; its result contains no message
content. Link audience is `public`, `restricted` or `unknown`; a URL grants no membership.
Without support, a validated target returns `url: null`, `access: unavailable`, and a reason.
Offline validates this account's stored message and returns reason `offline`, without connecting.
A locator for another messenger or account is refused. Singular `link` differs from graph `links`.

## The entry point of a CLI with its own program

A tool on `createProgram` starts through `run()`, which already handles signals and pipes. A tool that builds its own
commander program starts through `startCli` (from `@wirecat/cli-core/cli`), so its `src/bin/<command>.ts` is a few
lines:

```ts
#!/usr/bin/env node
import { enableCompileCache } from "node:module"
import { APP } from "../app.js"
import { reportFailure } from "../failure.js"

enableCompileCache()
const { startCli } = await import("@wirecat/cli-core/cli")
await startCli({
  app: APP,
  sqlite: true,
  run: async (entry) => (await import("../program.js")).run(entry),
  fail: (error, entry) => reportFailure(error, entry),
})
```

`startCli` catches a crash before the program's own handler (`catchCrashes`, with `reasons` and `interactive`),
aborts `entry.signal` on SIGINT and SIGTERM, ends with exit 0 when a reader closes the pipe (`| head`) and 3 when the
output cannot be written, runs `ensureSqlite` first with `sqlite: true`, and gives help and the version their own
exit code (help for a missing command exits 2). Any other failure goes to `fail` once. It sets `process.exitCode` and
never calls `process.exit`. The program gets the rest in `entry`: `atStart(command)` from a `preAction` hook runs the
first-run questions (`setupAtStart`, headless without a terminal, under CI, `--json`, `--jsonl` or `--no-input`, and
locked by `<PREFIX>_READ_ONLY`); `ask(question, command?)` is the consent prompt, false without asking in the same
cases; `openBrowser(url, browser?)` starts the system opener detached; `outputClosed()` says the pipe closed.
What only one tool needs — zm's batch input file and keyring — the tool builds inside `run`, with `entry.signal`.
Import the program lazily, as above: the compile cache and the SQLite swap only help what loads after them.

Such a program keeps its own runs ([WC-LIFE-15](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/lifecycle.md#wc-life-15--keep-a-run-log-through-cli-core-and-read-it-back-with-runs)):
`recordRuns(program, { app, content, settings, profile?, agent?, recognise? })` adds `--record` and `--no-record`,
and keeps every command as a run — a usage error before any action too, named by the command words it can read and
never an argument. `settings()` returns the saved `record`, `recordInput`, `keepRunsForDays`,
`keepSuccessfulRunsForDays` and `runsSizeLimitMb` (one that throws leaves the defaults); `profile()` names the run's
profile and, given at all, tells it that the first word may be a profile. Call it after the program's other
`parseAsync` wrappers. A provider client far from the program logs into the command's run with
`providerEvent(event)`, or `providerRequest(operation, sink?, { method, endpointTemplate, transport, attempt, waitMs,
bytes })`, which times one wire call and returns the function that ends it (`{ status?, error?, errorCode?,
providerError?, bytes?, counts?, ids? }`); `runEvent(event)` reaches the run of a `run()` command the same way. A
tool on `run()` gets the flags and the failure before a command from `run()` and keeps its own command's run with
`commandRuns(options)` — `start(action)`, `succeed()`, `fail(error)`, `runId()`, `events(event)` — from its
`prepare`, `postAction` and `onFailure`. `runSettings(flag, saved)` is the rule both use: the flag, else the saved
`record`, else on; `record: false` keeps failures only, `--no-record` keeps nothing.

**What is kept, and for how long.** Every run is kept, successes for `keep_successful_runs_for_days` (7) and
failures for `keep_runs_for_days` (30); past `runs_size_limit_mb` (200) the oldest successes go first, then the
oldest days, checked once a day. A success that logged no events is one line in the day's `index.jsonl` and no
folder; `runs show` reads it from there. A command that runs until stopped (`watch`, `serve`, `mcp`) and a command
WireCat Desktop runs for its own pages (`WIRECAT_CALLER=desktop`) keep a success only under `--record`. A run holds
at most 2,000 events or 1 MB; past that it counts the rest by operation in one `events.dropped` line and
`events_dropped`. `record_input` is `true` (the words typed, secrets hidden), `false` (every value that may be
content masked) or `"failed"` (the words typed only in a run that failed). A run says how it was asked for (`via`:
`cli`, `mcp-stdio`, `mcp-http`, `desktop`) and, for an MCP call, which call (`mcp`: tool, request id, connection id)
and which client (`agent.client`: its name and version, and over HTTP the first 8 hex of the SHA-256 of its OAuth
client id); over HTTP the server's own environment is never read for the agent. Request events carry `level`
(`operation` or `wire`), `transport`, `attempt` and `wait_ms`; `requests` counts wire calls when there are any.
Local records keep chat, person and file ids and paths; `doctor reports create` turns each into a label.

## Command discovery

The handbook's [WC-CMD-28](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-28--use-the-external-command-line-references-as-a-baseline-and-keep-the-projects-choices-where-they-differ) names
which POSIX, GNU, CLIG and agent-facing conventions we adopt. The [architecture](dev/ARCHITECTURE.md#cli-design-references)
shows where their contracts live; the [compliance audit](dev/CLI-COMPLIANCE.md) records
remaining gaps and deliberate differences.

To discover arguments without reading the whole command tree, run
`<cli> commands messages evidence --json`. Replace the path with any command or group;
`<cli> commands messages --json` includes its descendants. The response retains global options
and exit codes, includes options inherited from ancestor groups, and resolves command aliases.
Give one command path per call; inspect other groups in separate calls.
`<cli> commands --json` still returns the full tree.

`<cli> --help` and a bare `<cli>` show the first screen: the tool's pitch, the profile rule once, what the tool
can do, the other WireCat tools and pointers to `commands`, `help options` and `skill show`. A tool on
`createProgram` passes `firstScreen: { pitch, can }` in its definition; a tool that builds its own commander program
calls `installHelp(program, { pitch, can, profile?, start? })`. `<cli> help options` prints the options for
every command, and `<cli> --help-all` the full commander help.

`<cli> commands` without `--json` lists every command that runs, one line each, by section (Read, Write,
Organise, Automate, Set up, Other); `<cli> commands <path>` narrows it. cli-core's groups carry their section; a
tool puts its own groups in one with `inSection(command, "setup")`. A tool that builds its own program and keeps its own
`commands` command gets the same list from `commandsText(program, describeProgram(program), scope?)` (`scope` is the
path asked for, with `describeProgram` narrowed to it) and prints it when `--json` is not given; its `--json` stays
cli-base's `commandsDocument`, which is the same document.

Each leaf command's `--help` ends with **Returns** (the declared output entity and its first fields, or the
description), **Next usually** (up to three commands whose arguments take what it returns; `nextUsually(command,
{ pin, drop })` overrides them) and **Example** (the definition's `examples`, or one generated from the usage).
`commandHelpMarkdown(root, path)` renders the same for `docs/commands.md`; `exampleReport(program)` lists the
commands still on a generated example, and `pnpm help:examples` prints that list for the shared commands.

### Scenarios: `<cli> guide`

`<cli> guide` lists the tool's scenarios, then the ones it works with that another tool holds;
`<cli> guide <name>` prints one: the goal, each step as a command with one line of why, and what to look at.
`--json` gives the same as a list (`tool`, `name`, `title`, `goal`, `command`) or one item (`name`, `title`,
`goal`, `steps: [{ run, why }]`, `look`). `guide` takes no profile and is not an MCP tool.

A scenario is one Markdown file, `<name>.md`, in a directory the tool ships. The front matter holds everything the
command prints; the body is for the site's Examples page and the command does not read it.

```markdown
---
title: Catch up after a day away
goal: Know who waits on you and what you promised, without reading every chat.
steps:
  - run: tg review 'date>1d' --unanswered 4h
    why: questions to you that nobody answered, across every chat
look:
  - who asked first and how long ago
---
```

A step is written as a person types it: the tool's name first, no profile, as in a written example, and pasted into
a shell as is. A character a shell would act on — `>`, `<`, `|`, `&`, `;`, `` ` ``, `$(`, or a glob `*`, `?`, `[` —
goes inside quotes: `'date>1d'`, not `date>1d`, which writes a file named `1d` and drops the filter. The tool mounts
the command and names the directory, plus the cross-tool scenarios it lists by reference, taken from
`MEMO_SCENARIOS` so every tool shows the same title:

```ts
import { fileURLToPath } from "node:url"
import { checkGuide, guideCommand, MEMO_SCENARIOS } from "@wirecat/cli-core/cli"

guideCommand(app, {
  directory: fileURLToPath(new URL("../scenarios", import.meta.url)),
  worksWith: [MEMO_SCENARIOS.personBrief],
})

// In the tool's tests: every file parses, no step leaves a shell character unquoted, every step's command path
// exists and its options and arguments parse, on a program built fresh per step; no account, no network, no action
// runs. packageRoot checks `files` ships it.
expect(await checkGuide(() => createProgram(definition), { packageRoot: process.cwd() })).toEqual([])
```

`profile: false` drops the profile sentence for a tool whose commands take none.

## Evidence packets for agents

`prepareEvidencePacket` from `@wirecat/cli-core/services` packages a message page that the
caller has already read and authorised. It works with any messenger's domain messages:

```ts
import { prepareEvidencePacket } from "@wirecat/cli-core/services"

const packet = prepareEvidencePacket({
  kind: "chats", // or "news" or "person"
  source: { provider, account, chat: chatId },
  page,
  limits: { messages: 100, bytes: 64 * 1024 },
})
```

The packet preserves page order and keeps whole messages until either limit is reached. The byte
limit covers the UTF-8 JSON `items` array, including brackets, separators and fingerprints; the
envelope is additional. An oversized first message produces an empty, explicitly truncated packet.
`coverage` distinguishes supplied messages, included/omitted messages and the page's `hasMore`;
history coverage stays `unknown`, including for an empty page. Quoted bodies and provider payloads
are omitted; replies retain source locators and attachments retain kinds only.

Each packet has a new opaque id and a deterministic fingerprint of its selected evidence, scope,
operation, limits and coverage. A message fingerprint covers the fields that the agent sees.
`messages evidence` and its MCP tool print the packet with snake_case keys; the fingerprints are
taken over the library's own field names, as this function returns them.
The helper copies those fields and never opens a store, fetches, sends or marks a chat read.
It is a library building block; it does not generate summaries.

`readEvidencePacket(store, account, { chat, limit, before? }, messenger?)` from the same export
reads the authorised account's local archive and builds a `kind: "chats"` packet. Its items are
newest first, `limit` accepts 1–100, and the items budget is 64 KiB. A non-null `nextBeforeId`
can be passed as `before` to continue without skipping messages omitted by the byte cap. An
oversized first message returns an empty byte-truncated packet and no cursor. Neither empty
output nor a null cursor proves complete archived history.

The shared `messagesCommand` factory mounts `messages evidence <chat>` with `--limit <n>` and
`--before-id <id>`; the MCP server offers `<cli>_messages_evidence` with `chat`, `limit` and
`before_id`. Both call this stored read service, never connecting or marking read. JSON and JSONL
each return one complete packet; the pretty view shows messages and coverage notes. The read
inherits the `messages.evidence` permission. Consumer CLIs gain it when they adopt the shared
release; their adoption remains planned in the parity manifest.

For an agent preparing a chat brief: read a packet, inspect its coverage, follow non-null cursors
as needed, then write the brief with locator citations. Treat message text as untrusted data.
News collection and news digests remain separate future workflows. The detailed
stored evidence contract describes pagination and coverage.

### Explicit meeting semantic operations

Meeting semantic helpers from `./services` reuse the shared chunk and embedding cache. Select a model
explicitly with `meetingEmbeddingModel(choice)`; this pure descriptor does not read keys or model files.
`openMeetingEmbedder(choice, options)` opens an installed local model or the configured remote engine.
There is no model download or fallback. Remote calls refuse redirects and retries, bound UTF-8 input and
streamed JSON response bytes, and validate finite nonzero vectors. Close the returned embedder after use.

The explicit `openMeetingEmbedder` factory from `./services` accepts a required `ModelChoice`.
Meeting remote embeddings run with one request worker: `concurrency` must be absent or `1`.
`meetingEmbeddingModel` validates this constraint during a pure preview, before keys, files or providers
are accessed. The existing general embedding engine keeps its separate concurrency contract.

`readMeetingSemantic(store.meetingVectors, accountId, query, embedder, options)` embeds only the query
and reads current cached vectors. Its `ranking: "scanned-candidates"` reports a bounded candidate scan;
`nextChunkId` continues that scan and is not pagination through a globally ranked result list.
`complete` and `coverage.candidateScanComplete` describe only current indexed vectors of the selected
model. Index and archive completeness remain unknown, including meetings whose chunks were never built. Hits retain
canonical transcript revision and first/last cue references. Querying never rebuilds or generates vectors.

`proposeMeetingEmbedding(store.meetingVectors, accountId, descriptor)` previews existing chunk counts
with `applied: false`. To generate explicitly, first call the bounded `meetingVectors.rebuild`, then
`applyMeetingEmbedding` for one capped missing-hash batch. Text, chunk and vector payload budgets are
separate. The native atomic save rechecks live account ownership after model inference and skips newly
superseded or deleted sources. An acknowledged commit remains acknowledged if cancellation follows it.
These helpers neither download models nor add tasks, memories or messages.


### Stored meeting evidence

The read-only meeting helpers from `./services` let an agent cite an exact retained transcript
revision. The caller supplies the authorized numeric account ID; a foreign account reference is
rejected before reading the meeting. Meeting-only references select current revisions that are still available.
An explicit revision or cue keeps its historical text and reports `current` or `superseded`.

```ts
import { readMeetingEvidence, resolveMeetingReference, proposeMeetingTask } from "@wirecat/cli-core/services"

// Invented local records; the caller must authorize account 1 first.
const evidence = await readMeetingEvidence(store.meetings, 1, "meeting:1/2", { cues: 100, bytes: 65536 })
const cue = await resolveMeetingReference(store.meetings, 1, "meeting:1/2/3/0")
const proposal = await proposeMeetingTask(store.meetings, 1, "meeting:1/2/3/0", "promise")
```

Evidence keeps whole cues within its UTF-8 JSON `items` budget; envelope fields are additional.
Defaults are 100 cues and 64 KiB, with maxima of 1000 cues and 4 MiB. An oversized first cue returns
an empty byte-truncated packet. Cue fingerprints stay stable when their revision is superseded.
`coverage.input` is `bounded-meeting-pages`: these helpers require the native bounded meeting read
capabilities and never materialize complete meeting history. `maxReadBytes` caps stored TEXT per SQL
page (4 MiB by default), separately from the output JSON budget. A read visits at most
`maxTranscriptPages` revisions (100 by default, at most 1000). Capped coverage reports observed cues;
`providedExact` is false and `omitted` is null when further rows or revisions remain. Continue with
`after: coverage.nextReference`, or `afterTranscriptId: coverage.nextTranscriptId` when empty revisions
reach the revision-work cap. The cursor belongs to the same authorized source. Individual SQL reads
have snapshots; the service does not claim one snapshot across pages. Archive completeness remains unknown.

`personMeetingContext(store, "person:1", { accountIds: [1] })` reads linked meeting
participation for explicitly authorized accounts. A native account-presence check runs before the global
person lookup; a person seen only by other accounts returns `not_found` without exposing their name.
The allowed accounts are snapshotted before asynchronous reads. It returns current meeting context, without
claiming that the person spoke every returned cue. Defaults are 10 meetings, 5 cues per meeting,
64 KiB for the JSON `items` array, and a scan of at most 1000 mixed involvement rows. Coverage
reports the scan cap, queued changes and skipped unavailable meetings; it never claims complete history or matches people by
name or email. The helper does not rebuild the derived index.

A task proposal has a stable source-and-kind ID and `applied: false`; it creates no task or message.
The separate `createTaskFromMeeting(store, accountKey, { source, kind, origin, dueAt? })` helper
explicitly writes one local task after looking up the existing account and authorizing its source.
It accepts the task package's kinds and origins, keeps canonical references, and reuses an existing
task of the same kind; `rule` origin reuses any task from that source, including a closed task.
Deduplication follows the task package's sequential find-and-add contract; concurrent writers need
additional coordination. Proposal generation never calls this helper.

`readMeetingTask(store, accountKey, id)` resolves source text on demand, with a preview of at most
200 text characters. A deleted source returns `state: "unavailable"` and `source: null`; other source
errors propagate. The task itself retains its reference rather than transcript text.

Canonical meeting, revision and cue references can also be stored in memory and fact evidence
and in note links. Cue references use the actual cue position, and keep pointing to their retained
revision after a correction. Deleted parents refuse new links; existing evidence retains its source
reference so callers can report that it is unavailable.

`store.meetingVectors` shares the existing text chunks and model/content-hash embedding cache.
Explicit `rebuild({ accountId })` creates bindings for current live transcripts; `chunksToEmbed(model,
{ accountId, limit })` reads missing texts, and `saveCurrent(model, dims, rows, { accountId })`
rechecks their current account ownership atomically before caching model results. It acknowledges
saved and skipped hashes and never replaces an existing vector. No operation chooses a model,
downloads one or calls a provider.
Rebuild retires inactive transcript bindings and their orphaned model vectors atomically, while
preserving every hash still used by another corpus or live meeting binding.

Vector operations default to a 4 MiB aggregate text budget and 10,000 rows per transcript, with
explicit maxima of 64 MiB and 100,000 rows. Oversized rebuilds roll back the complete batch.
`nearest(model, query, { accountId, limit, maxChunks? })` defaults to scanning at most 1000 chunks
and ranks only those candidates. Its `ranking: "scanned-candidates"`, `scanned`, `complete`,
`hasMore` and `nextChunkId` fields distinguish a complete scan from continuation; continuation
pages do not promise a global ranking. Vector writes and scans additionally cap payloads at 16 MiB.

These helpers add no CLI or MCP command. Persisting meeting references through existing memory
or fact evidence links needs separate store integration.

## Charts from statistics

`statsCommand(messenger)` from `./cli` mounts `stats charts <chat>`. It answers `{ item }`, the chart:
messages per day/week, active authors, or joins and leaves (`--chart-kind`). `--output activity.svg`
or `--output activity.png` also saves a dark image in a new private file, named in the item's `file`. The command reads the same
statistics service; the chart itself never fetches extra history, sends or marks read. Missing dates
are gaps, and partial data is labelled. `--jsonl` and image output to stdout are unavailable.

The read-only MCP `stats_charts` returns the same chart JSON from the store, without writing a file
or connecting. Optional `format: "png"` returns PNG image content and JSON text containing
`chart` and `image: { format, width, height }`; the default remains JSON. Membership is unavailable in that stored mode because it needs online events.
Both interfaces inherit the `messages` read permission.

`./charts` exports the library-neutral `ChartData`, `ChartRenderer`, `chatChart`, `CHART_SIZE`
and the lazy `chartRenderer()` loader, plus the separate `chartPng(svg)` encoder. ECharts types stay in the renderer module; JSON-only commands
do not load it. PNG lazily loads resvg-js 2.6.2 and uses bundled Noto Sans Regular (SIL OFL 1.1),
with system fonts disabled. SVG does not load resvg. Pass a renderer loader as the second argument to `statsCommand` to replace the image implementation
while keeping the neutral data and command contract. Images default to a dark theme. ECharts is pinned at 6.1.0; its published unpacked files
plus zrender and tslib total about 61.6 MiB before package-manager deduplication.

## MCP from browser clients

Non-messenger consumers can use `serveOverHttp` and `revokeAll` from `/mcp`. The same entry exports
`publicUrlOf` and `portOf` to validate the public origin and local port with the messenger command rules.

Writes over MCP show no form, over stdio or HTTP: the profile's permissions decide, and a level of
`ask` goes ahead, since nobody is at a terminal to answer it. An app's own permission prompt is
separate and cannot be verified by the server; its “always allow” setting may permit later calls
without another prompt.

Repeat `--permission key=level` to make the profile's permissions stricter for the server process
only: `--permission messages.send=deny` stops sending, `--permission chats=readonly` keeps chats
read-only. An override that would loosen the profile, such as `messages.send=allow` in a read-only
profile, is refused at startup, naming the key. Recipient restrictions and hourly limits remain in
effect; no saved configuration is changed.

The browser connector uses the tunnel's HTTPS URL ending in `/mcp`, with the owner OAuth login.
Both legacy session-based and modern HTTP MCP clients are supported. Web clients can use tools
without prompts or resources; neither is required for reading and sending.

Message and author rankings are mounted by `statsCommand`: see the [ranking guide](rankings.md)
for metrics, scores, saved selections, evidence paging and data-quality limits.

### Private contact metadata and automatic tags

Both messenger consumers can keep private contact aliases, scoped to one account, and multiple notes,
which belong to the owner: a contact's notes show in every account that sees the contact.
`contacts aliases set <person> <alias>` and `contacts aliases remove <person>` affect local display and
resolution only. `contacts rename` continues to change the messenger address book. Show/list
retain the messenger name; a local alias adds `alias` and `displayName`. Duplicate aliases require
an explicit id. Stored direct-chat resolution supports aliases; it never invents a chat id from
an identity id. `contacts show --with-notes` includes private notes explicitly; the notes read permission still applies. Local metadata survives profile refresh and stays on its original identity/account
when identities are linked or unlinked.

`contacts notes add <person> --text-file <path>` (or stdin) creates a stable note id. Use `list`,
`show`, `edit --revision <number>` and `remove` for that person's notes. Notes are independent of
public bios, imported documents and source messages. They are rows of the store's `notes` table (version
25), linked to the contact, so `search notes` and `search all` find them too. `contacts list --search-notes
<text>` is an explicit substring search over the notes of the selected account's contacts.

`metadata show --chat <chat>` reads the cached group/channel description and fetched time.
`metadata sync --chat <chat>` reads it from the messenger, without changing the remote chat.
The refresh command accepts repeated chats and a bounded `--limit` (1–500).
`tags rebuild [--chat <chat>] [--limit 50]` classifies cached title, username and description with
versioned keyword rules. It works offline and uses only stored group/channel titles when there is
no full metadata snapshot. `--sync-first` explicitly fetches descriptions; `--dry-run`
previews cached results without writes. These flags cannot be combined. Results identify matched
fields and a rule score, not a topic probability. No model or message text is used.

Automatic tag claims are distinct from manual labels. Rerunning removes obsolete automatic tags
and preserves manual tags. Adding a label already generated promotes it to manual ownership;
listing generated tags includes `sources`. Use `tags list sources:manual` to select an ownership source and `tags remove --claim manual|auto` to remove only one claim. Removing a tag without a source removes its claims; a later explicit
automatic run can regenerate it. Upgrade consumers together before relying on manual promotion:
older builds cannot record manual ownership of an already generated label.

Administrator reports are mounted by the same `statsCommand`: `stats messages unanswered`,
`stats contacts responses`, `stats chats newcomers` and `stats messages discussion`. They read
held data only; [the guide](rankings.md#find-questions-and-posts-that-need-attention) explains
explicit reply attribution, selected answerers, unknown joining dates and bounded evidence.


`--json` prints text as it was written; MCP answers show control and direction characters visibly in
strings and keys. `--json=id,text` keeps only those fields. MCP contact searches keep third-party registries off
unless the caller explicitly sets `registries: true`.

## How often, and what may break

**Release when a consumer needs it, at any time** ([WC-REL-8](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/releases.md#wc-rel-8--any-package-may-release-at-any-time)). Changes wait under `## Unreleased`
until then; there is no gap to keep between releases and no weekly limit on breaking changes.

**A release that makes a CLI change its code moves every CLI that uses cli-core on the same day.** The parity
jobs build tg-cli, max-cli and whatsapp-cli from their `main` against every pull request; a change that fails
there, or passes only against a CLI branch made for it, needs those CLI branches ready before it is released.

**Before 1.0, any release may break a caller.** A change that does is listed in the changelog under
"Changed — may break callers", with what to change in a consumer.

The exports below are the ones consumers lean on most. A change to them is made with the most care and
always says what to change.

| Export | Stable |
|---|---|
| `.` | the domain types (`Chat`, `Message`, `Contact`, `Page`, …), the message locator |
| `./cli` | `Messenger`, `MessengerAdapter` and its method groups (`MessengerCore` required; `ServerReads` and the rest optional), `createProgram`, `run`, `messengerContext`, the command factories' names and arguments |
| `./store` | `openStore`, `MessageStore`, `storePath`, and the file format: `minCompatible` rises only in a release that lists it under "Changed — may break callers" |
| `./sends` | `sendGuard`, `SendJournal`, the journal's line format |
| `./speech` | The pinned speech-model catalogue, shared directories, verified installer and installed-only bounded PCM recognizer. Importing it does not load a recognizer or download a model |
| `./services` | `servicesFor`, `Override` and the service names |
| `./background` | `lockPath`, `readLock`, `holdLock`, `releaseLock`, `servingProfiles`, `alive`, `carries`, `holdersOf`, `ServerSystem`, `thisMachine`, `platformFor` and the systemd and launchd units · the serve relay: `listenRelay(path, run)`, `relayCommand(path, request, options)`, `relayPath(lockPath)`, `RELAY_PROTOCOL` |

`./testing` and `./parity` are not on this list. tg-cli and max-cli take new versions through Dependabot pull requests.
