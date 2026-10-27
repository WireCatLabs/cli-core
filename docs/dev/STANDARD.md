# The messenger rules for the WireCat CLIs

The rules every WireCat CLI follows are in the [WireCat CLI standards handbook](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/README.md), which ships in
`@wirecat/cli-base`. This page keeps what binds only the messenger CLIs — tg (tg-cli), max (max-cli) and wa
(whatsapp-cli), which share cli-core's messenger commands — and the contracts of cli-core's own shared commands:
the [parity manifest](#the-parity-manifest), the [option catalogue](#option-catalogue), `bot`, the messenger details
of the write guard, and how a messenger answer is presented. A heading whose rules moved to the handbook keeps one
paragraph naming the rules that hold them now, so a link to it still leads somewhere.

How a pull request is checked against these rules is [REVIEW.md](REVIEW.md).

A rule here changes first, in its own pull request, and the owner approves new wording. A word or a lint rule goes
into cli-base's registries first ([WC-CMD-2]); the tables below are regenerated from them with `pnpm standard:docs`,
and `pnpm docs:check` fails when the two differ. A difference between the messenger CLIs is allowed only where one
messenger lacks the feature, and it is written down with its reason in the parity manifest.

## External references and our adoption profile

This moved to the handbook: the external references are a baseline, and the project keeps its own choices where it
differs from them ([WC-CMD-28]). The [CLI compliance audit](CLI-COMPLIANCE.md) records what cli-core implements
against them and the gaps that are left.

## Command names

The general naming rules are on the handbook's [commands](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md) page: the path ([WC-CMD-1]), the
vocabulary ([WC-CMD-2]), root words ([WC-CMD-4]), one leaf per action and no overlap ([WC-CMD-6], [WC-CMD-7]),
no aliases ([WC-CMD-8]), and the names of options and arguments ([WC-CMD-10] to [WC-CMD-13]). The profile is on
the [accounts](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/accounts.md) page ([WC-ACCT-1] to [WC-ACCT-3]). An MCP tool's command is its CLI path
([WC-MCP-2]). What stays here is what cli-core's shared commands mean by their own resources and words, and `bot`.

### cli-core's resources

- **`tags` and `searches`** are the owner's own records in the local store, never sent; their writes have their own
  keys (`tags.add`), so a read-only profile hides them.
- **`tasks`** are what waits on the owner — a question nobody answered, a mention, a request, a promise — kept in the
  local store by `src/tasks/` and never sent: `tasks list|add|close|stats`, the type of a task is `--type`
  (`question`, `request`, `mention`, `promise`), and closing is `tasks close <task> --as done|dismissed
  [--reason <text>]`. The owner chose these on 2026-10-06; an agent adds `--certainty <0..1>` and the owner refuses an
  agent's unsure close with `tasks reject <task>` (2026-10-16).
- **`attachments`** are the files of stored messages: their text, read or written back, is kept in the local store for
  `content:` in a search and never sent; `attachments.extract` is a local write.
- **`chats tracking`** is the one collection named by what it does rather than a plural: the chats whose member lists
  `serve` fetches daily into the local store — owner's wording, 2026-10-05.
- **`chats documents`** are the Google Docs and Drive documents people linked in a chat's stored messages: a part of
  the chat, as its members are, so a subresource of `chats` and not a new root. `chats documents list <chat>` reads
  the local store only, and says per link whether the document is in the store. It does not overlap `chats media`,
  which reads every link from the messenger's server and knows no document, or `attachments list`, which lists files,
  not links in text. drive's `sync` writes the message → document link. Owner's name and design, 2026-10-13
  ([shared document links](chat-documents-plan.md)).

Every word for a command, a resource and a JSON key, with the words it replaces and where a CLI still uses another,
is in the [glossary](GLOSSARY.md).

### Messenger words

One word per idea in help, docs and errors. The **local store** is the message database the messenger CLIs share;
max's per-profile **cache** is a different thing until it is replaced, and keeps its name until then. `session` is
this tool's login; `account sessions` are the other devices. **`flood`** is what the messenger told this profile to
hold off on — the waits it asked for and a hold on writes — kept on this machine; `flood clear` is the owner's and
has no MCP tool. The **pace** is how fast one profile may ask its messenger, counted across every process
(`requests_per_minute`).

### Bot

**`bot` is the profile's bot account**, through the messenger's official Bot API and a bot token — never the personal
login. Below it, a command the personal account also has takes the same name, arguments and options:
`bot messages send`, `bot messages show <chat> <message>`, `bot chats members remove`, `bot chats moderate`,
`bot contacts show`, `bot watch`. What only a bot has: `bot auth`, `bot list`, `bot callbacks`, `bot commands` (the
menu people see on `/`), `bot webhooks`, `bot uploads`, `bot api`. A bot's send is never repeated — neither Bot API
makes a repeat safe — so `bot messages send` has no `--operation-id`. A bot command may add an option only a bot has,
as `bot watch --types` does.

wa's bot is a WhatsApp Business number on Meta's Cloud API, which never lets a client poll: `bot watch --public-url`
receives what Meta pushes, through the owner's tunnel, and a messenger's other secrets (Meta's app secret, the
webhook's verify token) are kept with `bot auth set --secret <name>`.

`bot api` is exempt from the naming rules: its names mirror each messenger's official Bot API operations.

Generated `bot api` commands use cli-base's generators and one command assembler in cli-core.
Only the source-specification adapter, transport and provider capabilities stay in the consumer.
Common inputs are `--body <json>` and `--body-file <path>`; `-` reads stdin. A native `timeout`
parameter is `--poll-timeout`, so it cannot replace the command's `--timeout` deadline.
Schema-declared file fields accept `@path`; ordinary strings never trigger a file read.

This advanced interface returns the official operation's native result, preserving MAX's existing
API contract. The normal bot commands use the shared domain output shapes. Both native interfaces
still use the common machine error contract, the profile's guard and send journal; a write with an
unknown outcome is never repeated automatically.

`--store-token <profile>` names the destination for an operation returning an authentication token.
It is required for those operations and rejected for other operations. The token is kept only in the
OS keyring and never printed; the result names the destination profile, bot id and storage kind.
A destination bound to a different bot is refused before a remote credential rotation. Secret
request fields have no generated argument flags: supply their JSON on stdin or in an existing
protected file. Tokens never enter diagnostics, traces or run records.

### Vocabulary and lint rules

The tables below are generated from `@wirecat/cli-base/standards` by `pnpm standard:docs`; edit the registry, not the
table. "Not" lists the words a term replaces. How `cli-dev lint` runs over a CLI, and its baseline, are
[WC-TOOL-16].

#### Verbs

<!-- verbs: generated -->

| Verb | Meaning | Not |
|---|---|---|
| `list` | show many | `ls` |
| `show` | show one | `get`, `view` |
| `search` | find by text; the description says where it looks | `find`, `query` |
| `prepare` | assemble bounded cited context for a selected upcoming activity without applying findings |  |
| `related` | what is nearest in meaning to one thing, without a query |  |
| `info` | facts about a singular thing itself: where it is, its size, its version, its schema |  |
| `status` | how a thing stands right now | `readiness` |
| `check` | verify, and change nothing; the answer says what is wrong and how to fix it | `audit`, `preflight` |
| `test` | run rules over what is already stored and say what they would have done, doing none of it |  |
| `apply` | run the owner's saved rules over what is already stored and change what they match; dry run unless --yes |  |
| `scan` | read stored messages for what a rule finds, such as tasks, and list it; records it only with --yes |  |
| `pause` | stop what a running process does for a profile, without stopping the process |  |
| `resume` | restart what pause stopped |  |
| `create` | make a thing | `mkdir` |
| `delete` | destroy a thing | `rm`, `trash` |
| `add` | put an existing thing into a set |  |
| `remove` | take a thing out of a set |  |
| `clear` | empty a set |  |
| `update` | change a thing's fields | `plan` |
| `set` | set one named key | `configure` |
| `unset` | remove one named key |  |
| `insert` | put bounded rows, columns or cells before an explicit position, shifting later entries |  |
| `format` | change how selected cells are displayed without replacing their values |  |
| `rename` | change a thing's name only |  |
| `start` | start a running process, or a login session |  |
| `stop` | stop a running process |  |
| `restart` | stop and start a running process |  |
| `end` | end a login session |  |
| `install` | install a system unit |  |
| `uninstall` | remove a system unit |  |
| `cancel` | stop a job or a pending thing |  |
| `sync` | bring the local store up to date from the source: only what changed, or the whole list where the source cannot say; a mirror syncs both ways | `refresh` |
| `fetch` | one bounded pull of one named thing into the store, not a catch-up |  |
| `unsync` | stop syncing a thing; what the store already holds stays |  |
| `export` | write from the store to a file |  |
| `import` | bring a file or list the user gives into the store or the messenger, once |  |
| `download` | save a file from the source to this machine |  |
| `transcribe` | turn speech into text |  |
| `extract` | read the text inside files already on this machine into the store |  |
| `migrate` | bring a file up to this build's schema |  |
| `backup` | copy a file somewhere safe |  |
| `restore` | put a backup back in its place |  |
| `repair` | bring a file's tables to this build's shape without deleting anything |  |
| `rebuild` | compute again, from what the store already holds, what the tool derives from it, keeping the owner's decisions |  |
| `link` | record that two identities are one person |  |
| `unlink` | undo a link |  |
| `lookup` | ask the messenger who is behind a phone number |  |
| `inspect` | look at a source before taking anything from it: a chat link without joining, a mailbox without importing |  |
| `send` | send a message |  |
| `edit` | change a sent message |  |
| `forward` | send an existing message on to another chat |  |
| `pin` | pin a message or chat |  |
| `unpin` | unpin a message or chat |  |
| `star` | mark a message so the owner finds it again; only the owner sees the star |  |
| `unstar` | take the owner's star off a message |  |
| `vote` | answer a poll |  |
| `answer` | reply to a button someone pressed under a bot's message |  |
| `respond` | answer an invitation: accept, tentatively accept or decline it |  |
| `press` | press a button under a bot's message; the bot sees who pressed it |  |
| `action` | show what a bot is doing in a chat, such as typing, for a few seconds |  |
| `watch` | follow new events as they come, and keep them |  |
| `close` | close a thing that stays: a poll, a task |  |
| `join` | join a chat |  |
| `leave` | leave a chat |  |
| `mute` | stop notifications from a chat for the owner; nobody in it is told |  |
| `unmute` | undo a mute |  |
| `block` | block a person |  |
| `unblock` | unblock a person |  |
| `mark-read` | mark a chat read; the other person sees it |  |
| `mark-unread` | mark a chat unread on the owner's own devices; nobody in it is told |  |
| `archive` | move a chat into the messenger's archive, out of the main chat list; nobody in it is told |  |
| `unarchive` | bring an archived chat back to the main chat list |  |
| `reset` | replace a thing; the old one stops working |  |
| `moderate` | apply a chat's rules: delete what breaks them, act on who broke them |  |
| `assign` | name the person responsible for work, with their task role |  |
| `reverse` | record that an accepted decision no longer holds, without replacing it |  |
| `invalidate` | mark a derived record whose supporting evidence no longer holds |  |
| `acknowledge` | record successful delivery using the exact receipt issued when the item was claimed |  |
| `confirm` | the owner accepts what an agent proposed | `accept`, `approve` |
| `reject` | the owner refuses what an agent proposed | `decline`, `deny` |
| `review` | list what waits for the owner's decision |  |
| `resolve` | settle one thing that waits for the owner's decision, with the owner's choice |  |
| `move` | move a file in the source |  |
| `copy` | copy a file in the source |  |
| `run` | run a saved job once, now, as its timer would |  |
| `claim` | take a thing for a while so no other agent works it at once; the claim lapses by itself |  |
| `release` | give back what claim took, before it lapses |  |
| `merge` | fold a duplicate into the thing that stays; nothing is deleted |  |
| `unmerge` | undo a merge |  |
| `defer` | leave a decision undecided, for the owner |  |
| `embed` | compute the vectors a meaning search reads, for what is stored and has none |  |
| `decrypt` | write an unencrypted copy of a file sealed by the tool, using the supplied password |  |
| `retry` | start a fresh attempt at partial or failed work, retaining the previous attempt |  |

<!-- verbs: end -->

#### Views

<!-- views: generated -->

| View | Meaning |
|---|---|
| `tree` | the parent and child hierarchy of stored sources |
| `logs` | the log of a running process |
| `events` | what happened in a thing over time |
| `scheduled` | what is scheduled to happen |
| `context` | what surrounds one thing |
| `path` | where a thing is on this machine |
| `config` | the configuration a thing needs |
| `history` | past uses of a thing |
| `top` | a ranked view under stats |
| `official` | the view the messenger itself computed, under stats |
| `transcript` | the text of speech: a voice message or a meeting recording |
| `evidence` | the stored messages or lines a result or a reference rests on |
| `passage` | a cited transcript line with bounded surrounding lines from the same revision |
| `agenda` | what needs a look today |
| `busy` | when calendars or people are taken, without what takes them |
| `categories` | the categories a thing takes, with what each means |
| `domains` | the internet domains links point to, most linked first |
| `places` | the street addresses confirmed as places, most mentioned first |
| `comments` | replies attached to a selected source item |
| `links` | links held for a selected thing |
| `voters` | people whose recorded votes are visible for a selected poll |
| `charts` | time series drawn from selected statistics, optionally rendered to a file |
| `newcomers` | members observed joining during the selected time window |
| `retention` | whether members of a selected cohort remain or return over time |
| `responses` | observed replies between participants and the time taken to answer |
| `discussion` | source posts compared by known views and observed discussion replies |
| `unanswered` | questions without an observed qualifying answer |
| `me` | the account a profile's token belongs to |
| `between` | the messages between two given messages of one chat |
| `app` | a bot's mini app: the address that opens it, signed in as the owner |

<!-- views: end -->

#### Resources

<!-- resources: generated -->

| Resource | Kind | Meaning | Not |
|---|---|---|---|
| `chats` | collection | conversations in a messenger |  |
| `contacts` | collection | identities in a messenger's contact list |  |
| `messages` | collection | posts in a messenger chat, or emails |  |
| `polls` | collection | polls in a chat |  |
| `reactions` | collection | reactions to a message |  |
| `recipients` | collection | who a message goes to |  |
| `replies` | collection | the automatic replies of a profile |  |
| `sends` | collection | messages waiting to be sent, or sent by this tool |  |
| `runs` | collection | past runs of this tool |  |
| `topics` | collection | forum topics in a group |  |
| `models` | collection | local or remote models |  |
| `tags` | collection | labels the owner puts on things |  |
| `searches` | collection | the owner's saved searches |  |
| `copies` | collection | tables kept aside by a repair |  |
| `tables` | collection | the tables of the local store, with their kind, row count and size |  |
| `attachments` | collection | files of stored messages |  |
| `tasks` | collection | what waits on the owner |  |
| `members` | collection | people in a chat |  |
| `admins` | collection | administrators of a chat |  |
| `tracking` | collection | the chats whose member lists are fetched daily |  |
| `documents` | collection | files imported from Google Drive or Docs, or linked in a chat |  |
| `notes` | collection | text the owner writes, or files from a notes folder |  |
| `projects` | collection | the owner's work units with a task key |  |
| `annotations` | collection | derived records attached to a selected entity, with explicit coverage of included and omitted facets |  |
| `organizations` | collection | companies, teams, families or communities |  |
| `identities` | collection | ways to reach a person or an organization: an account in one messenger or mailbox, an e-mail address, a phone |  |
| `facts` | collection | what happened, with evidence |  |
| `memories` | collection | what an agent concluded, with evidence and scope |  |
| `relationships` | collection | confirmed or suggested links between people, organizations and projects |  |
| `sheets` | collection | remote spreadsheets and their cell ranges, read or changed through a provider |  |
| `files` | collection | files in the source, such as Google Drive, read and changed there |  |
| `comments` | collection | comments people left on a thing in the source: a channel post or a file |  |
| `meetings` | collection | stored meetings, from Zoom or another provider |  |
| `calendars` | collection | calendars of an account, each synced or not |  |
| `events` | collection | calendar entries: meetings, appointments and other things on a calendar |  |
| `people` | collection | persons the owner deals with, such as the attendees of events |  |
| `recordings` | collection | the files a provider recorded of a meeting |  |
| `jobs` | collection | work this tool runs in the background or on a timer |  |
| `actions` | collection | what an agent proposes to do; the owner confirms or rejects each |  |
| `agents` | collection | the agents whose actions are recorded in the shared store |  |
| `reminders` | collection | scheduled notices about stored work, claimed and acknowledged with delivery receipts |  |
| `key-documents` | collection | selected source documents that a project keeps as its starting references |  |
| `answers` | collection | evidence-grounded answers assembled from selected stored sources |  |
| `aliases` | collection | other names of one thing |  |
| `mentions` | collection | phones, e-mail addresses, links and documents found in stored text, each where it was written |  |
| `images` | collection | pictures in stored messages, searched by what they show |  |
| `duplicates` | collection | pairs of things that may be one, each waiting for a decision |  |
| `sessions` | collection | devices and applications signed in to an account |  |
| `folders` | collection | named groupings of chats or source files |  |
| `links` | collection | stored or source-provided connections between selected things |  |
| `requests` | collection | requests waiting for an explicit decision |  |
| `rules` | collection | saved rules the owner applies to selected things |  |
| `conversations` | collection | derived stretches of chat messages grouped by topic |  |
| `batches` | collection | bounded work packets submitted or waiting for processing |  |
| `consents` | collection | recorded permission to process selected data with a specified service |  |
| `embeddings` | collection | vectors computed from stored content for similarity search |  |
| `reports` | collection | saved reports about selected data or a tool's state |  |
| `keys` | collection | credentials for a selected external service |  |
| `counters` | collection | stored observations of source counts, with their freshness |  |
| `gaps` | collection | ranges a source could contain that the local store does not hold |  |
| `callbacks` | collection | button presses a bot received and may answer |  |
| `webhooks` | collection | addresses a messenger pushes a bot's updates to |  |
| `templates` | collection | messages a business has approved in advance, the only kind some messengers deliver late |  |
| `media` | collection | files people sent, held by the messenger under an id |  |
| `session` | singular | this tool's login |  |
| `account` | singular | the messenger or mail account behind a profile |  |
| `mail` | singular | the local email archive and its mailbox import, rules and cleanup operations |  |
| `config` | singular | a profile's settings |  |
| `server` | singular | the long-running process of a profile |  |
| `store` | singular | the local SQLite database the tools share |  |
| `catalog` | singular | stored source file and folder metadata and parent relationships |  |
| `skill` | singular | the agent skill file of this tool |  |
| `cache` | singular | max's per-profile cache |  |
| `flood` | singular | what the messenger told this profile to hold off on |  |
| `vocabulary` | singular | the owner's catalogue of canonical names, with their aliases |  |
| `api` | singular | the source's own API, one command per operation |  |
| `privacy` | singular | who may find, see, call or add the account |  |
| `metadata` | singular | a profile's cached source attributes |  |
| `auth` | singular | the credentials a bot profile uses: its token and the secrets beside it |  |

<!-- resources: end -->

#### Root words

<!-- root words: generated -->

| Root word | Meaning |
|---|---|
| `batch` | run bounded explicitly registered reads with independent correlated answers |
| `inbox` | what waits across every chat |
| `review` | go through what needs the owner |
| `watch` | follow new events as they come |
| `serve` | the long-running process |
| `setup` | the guided first run: log in or link the account, then install the agent skill |
| `doctor` | check this machine's setup |
| `upgrade` | install a newer version of this tool |
| `commands` | the command tree as data |
| `guide` | scenarios: the commands for a common task, in order, and why each |
| `complete` | shell completion |
| `mcp` | the MCP server and its setup |
| `bot` | the profile's bot account |
| `stats` | statistics |
| `search` | searches across resources |

<!-- root words: end -->

#### Flags

<!-- flags: generated -->

| Flag | Value | Kind | Meaning | Unit |
|---|---|---|---|---|
| `--limit` | `<n>` | count | how many items | items |
| `--page` | `<n>` | count | which page, from 1, where the source has no cursor |  |
| `--page-size` | `<n>` | count | how many items one request to the source asks for | items |
| `--all` |  | switch | every item at once, instead of one page or one target |  |
| `--cursor` | `<cursor>` | cursor | continue from where the previous page ended |  |
| `--before-id` | `<id>` | id | read what came before this message id |  |
| `--after-id` | `<id>` | id | read what came after this message id |  |
| `--chunk-bytes` | `<n>` | count | how many bytes one chunk returns | bytes |
| `--offset-bytes` | `<n>` | count | where the chunk starts, in bytes from 0 | bytes |
| `--before-n` | `<n>` | count | how many messages or transcript lines before it | items |
| `--after-n` | `<n>` | count | how many messages or transcript lines after it | items |
| `--debug` |  | switch | on failure, show the full error record: cause and stack |  |
| `--agent-json` |  | switch | JSON with control and direction characters made visible in strings and keys |  |
| `--brief` |  | switch | each item as its reference, title, time and excerpt only |  |
| `--chart-kind` | `<messages\|active\|membership>` | choice | what a chart draws |  |
| `--checkpoints` | `<durations>` | list | the ages to report on, comma-separated: 1d,7d,30d |  |
| `--fields` | `<paths>` | list | only these comma-separated fields of each item; list metadata stays |  |
| `--format` | `<format>` | choice | the format of the file written |  |
| `--full` |  | switch | each item with its whole text and every field |  |
| `--json` |  | switch | machine-readable output: one JSON value on stdout, nothing else |  |
| `--jsonl` |  | switch | machine-readable output: one JSON object per line |  |
| `--output` | `<file>` | path | the file to write |  |
| `--output-dir` | `<dir>` | path | the folder to write into, created if missing |  |
| `--problems` |  | switch | only what went wrong: failures, warnings and crashes |  |
| `--quiet` |  | switch | no diagnostics on stderr |  |
| `--show-phone` |  | switch | print the whole phone number |  |
| `--thread-within` | `<duration>` | duration | messages within this long either side of the hit |  |
| `--trace` |  | switch | one line per request on stderr: ids and timings, never content |  |
| `--verbose` |  | switch | more detail in what is shown; repeat for more |  |
| `--version` |  | switch | print the version number |  |
| `--with-notes` |  | switch | include the owner's private notes |  |
| `--by` | `<group>` | choice | what the answer counts or groups by: a field or a calendar unit |  |
| `--context` | `<n>` | count | how many messages before and after each hit | messages |
| `--events` |  | switch | also print edits, deletions and other changes; every line names its event |  |
| `--all-versions` |  | switch | also the earlier versions a newer one replaced |  |
| `--measure` | `<name>` | choice | the metric a ranking is ordered by |  |
| `--newest` |  | switch | newest first instead of best first |  |
| `--plain-order` |  | switch | best first by the words alone, without moving mail from suspicious senders down |  |
| `--order` | `<recent\|name>` | choice | the order of a list: most recent first, or by name |  |
| `--score` | `<preset>` | choice | the named ranking score preset |  |
| `--weights` | `<json>` | string | the ranking component weights, all of them |  |
| `--meeting-inventory` |  | switch | expose read-only discovery of candidate series in the selected meeting account |  |
| `--meeting-project-candidates` |  | switch | expose read-only project suggestions from selected meeting evidence and the global project vocabulary |  |
| `--meeting-preparation` |  | switch | expose meeting preparation tools, including their remote schedule reads |  |
| `--dry-run` |  | switch | judge and plan; do nothing |  |
| `--accept-terms` |  | switch | accept the model's licence terms |  |
| `--as-owner` |  | switch | record the action as the owner's although an agent's terminal runs the tool |  |
| `--allow-any-file` |  | switch | send a file even from a credential folder or the tool's own folders |  |
| `--allow-dangerous` |  | switch | go ahead without the question an ask level puts before a deletion |  |
| `--allow-writes` |  | switch | permit writing: offer the profile's writing tools, or let a generic call change the source |  |
| `--as-file` |  | switch | send every file as a plain file to download |  |
| `--background` |  | switch | run as a job that outlives this command |  |
| `--base-url` | `<url>` | string | the address of an OpenAI-compatible model API |  |
| `--dims` | `<n>` | count | the embedding vector size |  |
| `--discover` |  | switch | also find partial matches; the results are evidence, not answers |  |
| `--encrypt` |  | switch | compress and encrypt with a password that is never kept |  |
| `--exact` |  | switch | bare words and quotes match their exact form only |  |
| `--fingerprint` | `<hash>` | string | refuse if what it names has changed since it was read |  |
| `--for-everyone` |  | switch | delete for everyone in the chat, not only for the owner |  |
| `--http` |  | switch | serve over HTTP on 127.0.0.1 |  |
| `--language` | `<lucene\|legacy>` | choice | the query language |  |
| `--local` |  | switch | use the model on this machine, never the source |  |
| `--max-age` | `<duration>` | duration | how old a stored snapshot may be and still count as fresh |  |
| `--draft` |  | switch | save text for the owner to review and send, without sending a message |  |
| `--md` |  | switch | the text is the messenger's Markdown |  |
| `--no-backup` |  | switch | do not back the file up before deleting it |  |
| `--no-input` |  | switch | never prompt or open an interactive login |  |
| `--no-preview` |  | switch | no preview card for a link in the text |  |
| `--no-record` |  | switch | do not keep this run, whatever the configuration says |  |
| `--no-registries` |  | switch | do not ask the public ban lists |  |
| `--notify` |  | switch | tell the people it concerns about it: the chat's members, or an event's attendees |  |
| `--no-notify` |  | switch | tell nobody about it |  |
| `--offline` |  | switch | answer from what was recorded and never connect |  |
| `--operation-id` | `<id>` | id | the write attempt this repeats, from an unknown outcome; a retry with it cannot write twice |  |
| `--port` | `<port>` | number | the local port for --http |  |
| `--public-url` | `<url>` | string | the public https address of the tunnel |  |
| `--record` |  | switch | keep this run, with the command as typed and secrets hidden; record_input false leaves the typed words out |  |
| `--regex` |  | switch | the words are one regular expression |  |
| `--silent` |  | switch | deliver without a notification |  |
| `--thread` |  | switch | the stored reply chain instead of time neighbours |  |
| `--timezone` | `<zone>` | string | the IANA timezone dates and times are read in |  |
| `--yes` |  | switch | go ahead with the write without asking or previewing first |  |
| `--allow-delete` |  | switch | permit a call that deletes for good |  |
| `--allow-remote` |  | switch | consent to sending the stored data to the configured remote model |  |
| `--answerer` | `<person>` | string | a person whose reply counts as an answer; repeat it for more |  |
| `--browser` | `<program>` | string | the browser program to open for sign-in |  |
| `--checkpoint` | `<file>` | path | keep resume progress in this file |  |
| `--expected-event-id` | `<id>` | id | refuse unless the linked event is still this one, or none |  |
| `--expected-person` | `<uid>` | id | refuse unless the linked person is still this one, or none |  |
| `--html` |  | switch | the text is HTML |  |
| `--idle` | `<duration>` | duration | stop after this long with nobody using it |  |
| `--interactive` |  | switch | allow approving in a browser from an interactive terminal |  |
| `--meeting-context` |  | switch | expose meeting evidence, person context and task proposal tools |  |
| `--method` | `<method>` | choice | how to log in when there is no session |  |
| `--model` | `<model>` | string | the model that does the work: a local model's id or the provider's model name |  |
| `--models-dir` | `<dir>` | path | the folder installed models are read from |  |
| `--no-browser` |  | switch | print the sign-in address instead of opening a browser |  |
| `--no-resume` |  | switch | start over, keeping no resume state |  |
| `--no-serve` |  | switch | do not start the long-running process; use this command's own connection |  |
| `--pause` | `<duration>` | duration | wait this long between requests to the source, to stay under its limits |  |
| `--permission` | `<key=level>` | string | override one permission for this run; repeat it for more |  |
| `--read-only` |  | switch | refuse every write, local and remote |  |
| `--append` |  | switch | keep existing entries and add the explicitly named one beside them |  |
| `--replace` |  | switch | overwrite an existing one of the same name |  |
| `--rescan` |  | switch | list everything again, not only what changed since the last run |  |
| `--resume` |  | switch | continue verified partial work from the last run |  |
| `--revision` | `<n>` | count | the revision read before this edit; a change made meanwhile refuses it |  |
| `--secret-stdin` |  | switch | read a secret from a pipe, or ask for it; never from the command line |  |
| `--semantic` |  | switch | expose read-only search by meaning, with an explicit query model |  |
| `--serve` |  | switch | start the long-running process in the background when it is not running |  |
| `--size` | `<n>` | count | how many messages in one batch | messages |
| `--unified-search` |  | switch | expose search across resources for the selected profile |  |
| `--within` | `<duration>` | duration | the window after an event that counts |  |
| `--grant` | `<scopes>` | list | also ask for these permissions at sign-in, comma-separated; the command lists them |  |
| `--min-similarity` | `<n>` | number | how alike two names must be to count as a match, from 0 to 1 |  |
| `--analyze` |  | switch | also analyze with the configured provider |  |
| `--agent` | `<agent>` | choice | also install the agent skill for this agent after logging in |  |
| `--catch-up` |  | switch | prepare local search: after this run, or before a search reads it |  |
| `--extract` |  | switch | also read the text inside the files written |  |
| `--mark-read` |  | switch | also mark the chat read up to the newest message shown; the other person sees it |  |
| `--no-catch-up` |  | switch | skip local preparation after this run |  |
| `--retract` |  | switch | take the owner's vote back |  |
| `--revoke` |  | switch | forget every login given to a browser app |  |
| `--track` |  | switch | also do it daily while serve runs |  |
| `--transcribe` |  | switch | also transcribe voice messages not transcribed yet, on this machine |  |
| `--block` |  | switch | also keep them from coming back by the chat's link |  |
| `--check` |  | switch | also ask the source and say what it answers: a newer version, who a bot is, whether a login works |  |
| `--download` |  | switch | first download the files not downloaded yet |  |
| `--embed` |  | switch | also embed what is pending, for search by meaning |  |
| `--export` | `<dir>` | path | also write it as a file, to this folder or the configured one |  |
| `--no-block` |  | switch | remove without keeping them from coming back |  |
| `--no-embed` |  | switch | skip embedding for search by meaning this run |  |
| `--no-mark-read` |  | switch | do not mark read, whatever the configuration says |  |
| `--ocr` |  | switch | also read the text in images and scanned PDFs with the configured OCR model |  |
| `--online` |  | switch | also connect once and read the account; sends nothing |  |
| `--sync-first` |  | switch | first bring what it reads up to date from the source |  |
| `--domain-age` |  | switch | also ask each domain's registry when it was registered; the registry learns the domain |  |
| `--retry-attachments` |  | switch | also reread the stored attachments whose text was not read before |  |
| `--meetings` | `<n>` | count | at most this many stored meeting occurrences in context | meetings |
| `--cues` | `<n>` | count | at most this many transcript cues per selected occurrence | cues |
| `--context-limit` | `<n>` | count | at most this many entries per context category | items |
| `--scan-limit` | `<n>` | count | at most this many stored candidates inspected for one bounded read | items |
| `--bytes` | `<bytes>` | count | at most this many bytes of included evidence content | bytes |
| `--max-read-bytes` | `<bytes>` | count | at most this many stored text bytes read for one bounded evidence window | bytes |
| `--depth` | `<n>` | count | maximum descendant depth in a hierarchy | levels |
| `--timeout` | `<duration>` | duration | give up after this long |  |
| `--catch-up-chunks` | `<n>` | count | at most this many chunks prepared after the run | chunks |
| `--catch-up-messages` | `<n>` | count | skip the graph rebuild above this many messages | messages |
| `--concurrency` | `<n>` | count | requests to the source at once | requests |
| `--deep` | `<n>` | count | also check the top n in full, one a second | people |
| `--max-actions` | `<n>` | count | at most this many actions in one run | actions |
| `--max-chats` | `<n>` | count | at most this many chats in one run | chats |
| `--max-chunks` | `<n>` | count | at most this many chunks in one run | chunks |
| `--max-gaps` | `<n>` | count | at most this many gaps repaired in one run | gaps |
| `--max-input-bytes` | `<bytes>` | count | at most this many bytes of buffered stdin | bytes |
| `--max-messages` | `<n>` | count | at most this many messages in one run | messages |
| `--max-replies` | `<n>` | count | at most this many replies read | replies |
| `--max-tokens` | `<n>` | count | at most this many model tokens in one run | tokens |
| `--thread-bytes` | `<n>` | count | at most this many bytes in each thread context | bytes |
| `--thread-hops` | `<n>` | count | at most this many links from the hit | links |
| `--thread-messages` | `<n>` | count | at most this many messages in each thread context | messages |
| `--catch-up-time` | `<duration>` | duration | how long local preparation after the run may take |  |
| `--max-bytes` | `<bytes>` | count | at most this many bytes of one file read or downloaded | bytes |
| `--max-comparisons` | `<n>` | count | at most this many name comparisons | comparisons |
| `--max-cost` | `<usd>` | number | stop a run that costs more than this | US dollars |
| `--max-duration` | `<duration>` | duration | the longest audio it takes on |  |
| `--max-entries` | `<n>` | count | at most this many entries read | entries |
| `--max-meetings` | `<n>` | count | at most this many meetings looked through, newest first | meetings |
| `--max-output-bytes` | `<bytes>` | count | at most this many bytes of machine output; 0 means no limit | bytes |
| `--max-pages` | `<pages>` | count | at most this many pages read from the source | pages |
| `--max-rows` | `<n>` | count | at most this many transcript lines read | lines |
| `--max-segments` | `<n>` | count | at most this many recognized segments | segments |
| `--max-subscriber-buffer-bytes` | `<bytes>` | count | at most this many bytes buffered for one watcher before it is cut off; 0 means no limit | bytes |
| `--max-subscriber-total-buffer-bytes` | `<bytes>` | count | at most this many bytes buffered for all watchers together; 0 means no limit | bytes |
| `--max-text-bytes` | `<bytes>` | count | at most this many bytes of transcript text read | bytes |
| `--max-total-bytes` | `<bytes>` | count | at most this many bytes in all, checked before any write | bytes |
| `--max-transcript-pages` | `<n>` | count | at most this many transcript pages read | pages |
| `--repair-time` | `<duration>` | duration | how long a repair may take |  |
| `--server-time` | `<duration>` | duration | stop waiting for the server's answer after this long |  |
| `--sync-time` | `<duration>` | duration | stop fetching from the source after this long |  |
| `--threads` | `<n>` | count | threads on this machine, in all | threads |
| `--workers` | `<n>` | count | sessions in parallel on this machine, each with its own copy of the model | sessions |
| `--input` | `<mode>` | choice | how supplied cell values are parsed: literal values or provider-interpreted formulas and locale formats |  |
| `--render` | `<mode>` | choice | how returned cell values are represented: formatted display values, unformatted values or formulas |  |
| `--analysis-provider` | `<provider>` | choice | who analyses the selected text: the calling agent or a configured model service |  |
| `--embedding-provider` | `<provider>` | choice | who computes embeddings: a local model or a configured remote model service |  |
| `--consent-provider` | `<identity>` | string | the exact model-service identity whose recorded consent is being removed |  |
| `--claim` | `<claim>` | choice | the ownership claim to remove from a tag: manual or auto |  |
| `--answer-model` | `<model>` | string | remove only stored analysis answers made by this model; does not run a model |  |
| `--template-mode` | `<mode>` | choice | the saved reply template's policy: fill-only or may-reword |  |
| `--disappear-after` | `<duration\|off>` | duration | how long a new chat message is kept after sending; off keeps messages |  |
| `--only-admins-edit-info` | `<on\|off>` | choice | only admins may change the chat's name, photo and description |  |
| `--only-admins-send` | `<on\|off>` | choice | only admins may send messages to the chat |  |
| `--remove-photo` |  | switch | remove the chat's photo; not with a replacement photo |  |
| `--sticker-file` | `<file>` | path | a local sticker file to send as a message |  |
| `--target-store` | `<file>` | path | explicit destination store file for checking or restoring selected annotations |  |
| `--bindings` | `<file>` | path | JSON file mapping source typed references to explicitly selected destination references |  |
| `--context-source` | `<id=cursor>` | string | explicitly selected communications source, optionally with its scoped continuation cursor; repeat for more sources |  |
| `--context-query` | `<words>` | string | literal words to find within the communications selected for preparation |  |
| `--alias` | `<name>` | string | another name of the thing, searched as its own alternative beside its name; repeat for more |  |
| `--context-since-time` | `<time>` | time | inclusive start of the selected communications window used for preparation |  |
| `--context-before-time` | `<time>` | time | exclusive end of the selected communications window used for preparation |  |
| `--account` | `<account>` | string | the account to use; never assumed |  |
| `--provider` | `<provider>` | choice | read every account of this provider |  |
| `--source` | `<accounts>` | list | what to read: provider:account, a provider, a kind or group:<name>; comma-separated |  |
| `--all-bots` |  | switch | also read every other bot's copy on this machine that the configuration allows |  |
| `--archive` | `<dir>` | path | also read the transcripts in this archive folder |  |
| `--backend` | `<archive\|server\|both>` | choice | where to search: the local archive, the source's server, or both |  |
| `--bots` | `<profiles>` | list | also read these bots' copies, comma-separated, each allowed by the configuration |  |
| `--only` | `<resources>` | list | only these resources, comma-separated |  |
| `--profile` | `<name>` | string | the profile to use, instead of the first word |  |
| `--history-since-time` | `<time>` | time | inclusive start of the stored history window used for preparation |  |
| `--expected-fingerprint` | `<hash>` | string | require what it reads to match this fingerprint from an earlier read |  |
| `--before-time` | `<time>` | time | read what came before this time |  |
| `--after-time` | `<time>` | time | read what came after this time |  |
| `--since-time` | `<time>` | time | only what came since this time |  |
| `--until-time` | `<time>` | time | only what came up to and including this time |  |
| `--batch` | `<id>` | id | the batch to act on, by the id that listed it |  |
| `--component` | `<name>` | string | the ranking component to read the evidence of |  |
| `--counters` | `<names>` | list | the counters to read: views, reactions, comments |  |
| `--failed` |  | switch | every chat whose newest job failed or died |  |
| `--left` |  | switch | only the chats this account has left |  |
| `--others` |  | switch | every session but this one |  |
| `--saved` | `<name\|id>` | string | run a saved search, or an earlier run by its id |  |
| `--selection` | `<json>` | string | the resolved ranking selection a drilldown returned |  |
| `--attachment` | `<n>` | count | which file of the message, from 1; needed when it has more than one |  |
| `--bot` |  | switch | the bot section of the configuration, not the personal account's |  |
| `--chat` | `<chat>` | id | the chat it acts on: its id or name; repeat it where several are taken |  |
| `--contact` | `<person>` | id | a contact: their id, @username or name, as the store knows them |  |
| `--defaults` |  | switch | what every profile gets, not only this profile |  |
| `--file-ids` | `<ids>` | list | only these files, by comma-separated ids |  |
| `--folder` | `<folder>` | string | a notes folder, by its id or path; repeat it for more |  |
| `--for` | `<agents>` | list | the agents to install for, comma-separated |  |
| `--from-dir` | `<dir>` | path | match files in this folder, not its subfolders |  |
| `--last` | `<n>` | count | stop once the newest n messages are held | messages |
| `--link` | `<link>` | string | an invite link |  |
| `--lookback-days` | `<days>` | count | look again at this many recent days, for what arrived late | days |
| `--meeting-id` | `<id>` | id | one stored meeting selected for transcript search |  |
| `--identity-id` | `<id>` | id | a stored participant identity whose meetings are selected; does not identify the speaker of a hit |  |
| `--person-id` | `<id>` | id | a stored person whose linked participant identities select meetings |  |
| `--series-id` | `<id>` | id | one stored recurring series selected for meeting search |  |
| `--meeting` | `<id>` | id | a meeting, by its store id |  |
| `--message` | `<message>` | id | a message: its id in --chat, or a msg: locator alone |  |
| `--new` |  | switch | only what is new since this command last ran, each once; for scheduled runs |  |
| `--note` | `<reference>` | string | a note: note:<id>, or a file in a notes folder: document:<id> |  |
| `--occurrence-id` | `<id>` | id | one occurrence of a recurring meeting |  |
| `--old-parent` | `<id>` | id | the folder to take it out of, by id |  |
| `--only-missing` |  | switch | only what has none yet |  |
| `--organization` | `<organization>` | string | an organization: its id or organization:<id> |  |
| `--parent` | `<id>` | id | the folder or task it sits under, by id |  |
| `--participant-id` | `<id>` | id | a participant of the meeting, by id |  |
| `--person` | `<uid>` | id | a person, by their stored UID |  |
| `--personal` |  | switch | the personal-account section of the configuration |  |
| `--project` | `<project>` | string | a project: its key or project:<id> |  |
| `--recheck-since-time` | `<time>` | time | look again from this day, for what arrived late |  |
| `--run` | `<id>` | id | the run it is about |  |
| `--target` | `<ref>` | string | what it acts on, as a reference: msg:, chat:, person:, task:, … |  |
| `--secret` | `<name>` | choice | which secret beside a bot's token to keep, typed at a hidden prompt; never the secret itself |  |
| `--store-token` | `<profile>` | string | keep a token an operation returns only in this bot profile's keyring; never print it |  |
| `--task` | `<id>` | id | a task, by id |  |
| `--to` | `<chat>` | id | the chat it goes to |  |
| `--topic-name` | `<name>` | string | a stored meeting topic label, by name or alias |  |
| `--topic` | `<id>` | id | the forum topic, in a chat that has topics |  |
| `--transcript-id` | `<id>` | id | one transcript version, by id |  |
| `--until-id` | `<id>` | id | up to and including this message id |  |
| `--uuid` | `<uuid>` | string | one meeting occurrence, by its UUID |  |
| `--ignore` | `<path>` | path | also skip this file or folder, a path or a glob; repeat it for more |  |
| `--subfolder` | `<path>` | path | a subfolder inside --folder |  |
| `--into` | `<id>` | id | the existing thing it goes into, instead of standing alone |  |
| `--all-in-chat` |  | switch | also every undecided place of the same value in its chat |  |
| `--due-within` | `<duration>` | duration | what falls due within this long from now |  |
| `--unanswered` | `<duration>` | duration | chats where someone else wrote last at least this long ago |  |
| `--waiting` | `<duration>` | duration | chats where the owner wrote last and nobody answered for at least this long |  |
| `--at-time` | `<time>` | time | do it at this time |  |
| `--add` | `<chat>` | id | put this chat into the set being changed; repeat it for more |  |
| `--all-can-pin` | `<on\|off>` | choice | every member may pin messages |  |
| `--anonymous` |  | switch | nobody sees who voted for what |  |
| `--approval` |  | switch | who joins by the link asks first, and an admin lets them in |  |
| `--can` | `<rights>` | list | what an admin may do, comma-separated |  |
| `--channel` |  | switch | a channel instead of a group |  |
| `--certainty` | `<n>` | number | how sure the agent is, from 0 to 1; kept with what it wrote |  |
| `--closed` | `<on\|off>` | choice | close it to new messages, or reopen it |  |
| `--comment-to` | `<post>` | id | comment on this channel post |  |
| `--description` | `<text>` | string | the new description |  |
| `--expire-time` | `<time>` | time | it stops working at this time |  |
| `--first-name` | `<name>` | string | the account's first name |  |
| `--hidden` | `<on\|off>` | choice | hide it from the list, or show it |  |
| `--last-name` | `<name>` | string | the account's last name |  |
| `--max-uses` | `<n>` | count | at most this many people join by it | people |
| `--members-see-link` | `<on\|off>` | choice | members may see the invite link |  |
| `--multiple` |  | switch | people may pick several answers |  |
| `--only-admins-add` | `<on\|off>` | choice | only admins may add members |  |
| `--only-admins-call` | `<on\|off>` | choice | only admins may start a call |  |
| `--only-owner-edits-info` | `<on\|off>` | choice | only the owner may change the name and photo |  |
| `--photo` | `<file>` | path | an image file: a profile or chat photo, or a photo to send |  |
| `--pinned` | `<on\|off>` | choice | pin it at the top of the list, or unpin it |  |
| `--remove` | `<chat>` | id | take this chat out of the set being changed; repeat it for more |  |
| `--reply-to` | `<message>` | id | answer this message in the same chat |  |
| `--revote` |  | switch | people may change their vote |  |
| `--send-as` | `<id>` | id | send as this identity of the chat |  |
| `--voice` | `<file>` | path | an Ogg Opus file sent as a voice message |  |
| `--about-text` | `<who>` | choice | who sees the about text: everyone, contacts or nobody |  |
| `--calls` | `<who>` | choice | whose calls ring: everyone, contacts or nobody |  |
| `--chat-invites` | `<who>` | choice | who may add the account to groups and channels: everyone, contacts or nobody |  |
| `--find-by-phone` | `<who>` | choice | who finds the account by its number: everyone, contacts or nobody |  |
| `--hide-online` | `<on\|off>` | choice | hide online status and last seen |  |
| `--last-seen` | `<who>` | choice | who sees when the account was last online: everyone, contacts or nobody |  |
| `--phone-number` | `<who>` | choice | who sees the number: everyone, contacts or nobody |  |
| `--profile-photo` | `<who>` | choice | who sees the profile photo: everyone, contacts or nobody |  |
| `--read-receipts` | `<on\|off>` | choice | send read receipts |  |
| `--until` | `<time>` | time | only until then: a local time, or a duration from now |  |
| `--agenda` | `<text>` | string | the meeting's agenda |  |
| `--allow-chats` | `<ids>` | list | the chats allowed, by comma-separated ids; empty clears |  |
| `--allow-people` | `<ids>` | list | the senders allowed, by comma-separated ids; empty clears |  |
| `--as` | `<state>` | choice | how it is closed: done, or dismissed when it needs no answer |  |
| `--assignee` | `<person...>` | list | who does it, by UID |  |
| `--at` | `<hh:mm>` | string | every day at this local time |  |
| `--body` | `<json>` | string | the request body, as JSON |  |
| `--caption-above` |  | switch | show the text above the photo or file, not below it |  |
| `--close-time` | `<delay>` | duration | it closes by itself this long after sending |  |
| `--correct` | `<n>` | count | with --quiz, the right answer's position, from 1 |  |
| `--deny-chats` | `<ids>` | list | the chats left out, by comma-separated ids; empty clears; deny wins |  |
| `--deny-people` | `<ids>` | list | the senders left out, by comma-separated ids; empty clears; deny wins |  |
| `--due` | `<time>` | time | when it must be done |  |
| `--duration-minutes` | `<minutes>` | count | how long the meeting lasts, in minutes | minutes |
| `--emoji` | `<emoji>` | string | the icon |  |
| `--event-id` | `<id>` | id | the stored calendar event it is linked to, or none to unlink |  |
| `--every` | `<duration>` | duration | repeat this often |  |
| `--evidence` | `<ref...>` | list | what shows it: msg:, note:, meeting:, person: or another reference |  |
| `--exclude-chat` | `<chat>` | id | never show this chat in it; repeat it for more |  |
| `--file` | `<file>` | path | a file to send with the message; the text becomes its caption |  |
| `--filename` | `<name>` | string | the name others see for the file, instead of its name on disk |  |
| `--history` |  | switch | the people added also see the messages from before they came |  |
| `--include` | `<kinds>` | list | every chat of these kinds, comma-separated |  |
| `--join-approval` | `<on\|off>` | choice | people ask to join the chat, and an admin lets them in |  |
| `--key` | `<key>` | string | the short key, 3–4 letters and digits; made from the name when left out |  |
| `--kind` | `<kind>` | choice | what kind of thing it is; the command lists the kinds |  |
| `--name` | `<name>` | string | the name to give it |  |
| `--no-approval` |  | switch | anyone with the link joins at once |  |
| `--notification` | `<text>` | string | a note only the person who pressed sees |  |
| `--params` | `<json>` | string | the request's query and path parameters, as JSON |  |
| `--payload` | `<json>` | string | the data of what to do, as JSON |  |
| `--pin` | `<chat>` | id | pin this chat at the top of it; repeat it for more |  |
| `--priority` | `<n>` | count | 0 urgent … 4 low |  |
| `--quiz` |  | switch | a quiz: one answer is right, and a vote is final |  |
| `--reason` | `<text>` | string | why, in a few words; kept with it |  |
| `--remind-time` | `<time>` | time | when to look at it again |  |
| `--role` | `<role>` | string | the part it plays, in a word or two |  |
| `--scope` | `<scope>` | choice | personal or work: which side of the owner's life it belongs to |  |
| `--solution` | `<text>` | string | with --quiz, what people see once they answered |  |
| `--spoiler` |  | switch | hide the photo or video behind a spoiler until tapped |  |
| `--start` | `<param>` | string | the start parameter the bot or app reads |  |
| `--start-time` | `<time>` | time | when it starts |  |
| `--sticker` | `<id>` | id | send this sticker, alone |  |
| `--subject` | `<ref>` | string | what it is about, as a reference |  |
| `--supersedes` | `<ref>` | string | the earlier one this replaces, as a reference |  |
| `--text` | `<text>` | string | the text |  |
| `--text-file` | `<path>` | path | read the text from this file; - reads stdin |  |
| `--title` | `<title>` | string | the title or name to give it |  |
| `--type` | `<type>` | choice | what type of thing it is; the command lists the types |  |
| `--types` | `<types>` | list | the update types, comma-separated, in the messenger's words |  |
| `--occurred-time` | `<time>` | time | when it happened |  |
| `--clear` |  | switch | unset it, instead of setting a new value |  |
| `--do` | `<actions>` | list | what a rule does when it matches, comma-separated; the command lists the actions |  |
| `--sender` | `<address>` | string | a sender, by email address |  |
| `--domain` | `<domain>` | string | an internet domain, such as example.com |  |
| `--list-id` | `<id>` | id | a mailing list, by its List-Id header |  |
| `--category` | `<name>` | choice | what it is about; the command lists the categories |  |
| `--holder` | `<name>` | string | who takes or holds a claim: a session or chat id; the command says its default |  |
| `--lease` | `<duration>` | duration | how long a claim lasts before it lapses by itself; claiming again extends it |  |
| `--filter` | `<query>` | string | a query every result must also match, beside the search's own words |  |
| `--values` | `<json>` | string | cell values as JSON rows for an explicit range update or row append; not a list filter |  |
| `--end-time` | `<time>` | time | when it ends |  |
| `--start-date` | `<date>` | time | the first day of something that lasts whole days, such as an all-day event |  |
| `--end-date` | `<date>` | time | the last day of something that lasts whole days, such as an all-day event |  |
| `--location` | `<text>` | string | where it takes place |  |
| `--attendee` | `<email>` | string | a person invited to the event, by email address; repeat it for more |  |
| `--id` | `<id>` | id | the id to create it with, chosen beforehand, so a retry finds it instead of making a second one |  |
| `--calendar` | `<id>` | id | the calendar it acts on, when the thing is on more than one |  |
| `--repeat` | `<rule>` | string | how it repeats, as an RFC 5545 rule such as FREQ=WEEKLY;BYDAY=MO;COUNT=10 |  |
| `--hours` | `<from-to>` | string | the working hours of each day to look in, such as 09:00-17:00, in the owner's time zone |  |
| `--series` |  | switch | act on the whole repeating event, not only this occurrence |  |

<!-- flags: end -->

#### Lint rules

<!-- lint rules: generated -->

| Rule | Severity | Applies to | Holds when |
|---|---|---|---|
| `unknown-verb` | high | command | a command's last word is a verb or view noun from the vocabulary; a top-level one may be a root word; under search, a resource or all |
| `unknown-resource` | medium | group | a group is a resource from the vocabulary (plural, or a registered singular) or a root word |
| `flag-two-meanings` | high | flag | a flag takes the same kind of value in every command, and the one the vocabulary gives it |
| `missing-command-help` | high | command | every command has a summary |
| `missing-command-effects` | high | command | every command that runs declares its effects: each leaf, and a group with an action of its own |
| `command-help-too-long` | low | command | a summary is at most 80 characters |
| `command-example-count` | medium | command | a leaf command has one to three examples; generated commands are exempt |
| `faulty-help-example-parameters` | high | command | an example starts with the tool, runs its own command, and gives only arguments and options it takes |
| `missing-argument-help` | high | argument | every argument is described |
| `missing-option-help` | high | option | every option is described |
| `key-casing` | high | key | every key of a registered JSON Schema and of the commands document is snake_case |
| `filter-flag` | high | option | a command that changes nothing filters with its query, not with a flag named after a field of its entity |
| `option-role` | high | option | every option has a role in the vocabulary; a filter has none, it is a query field |
| `list-without-query` | medium | command | a list that answers with an entity takes a query over that entity's fields |
| `query-example` | high | command | every query field's example, and every default term, parses and validates |
| `nullable-list` | medium | key | a list in a registered JSON Schema is never null: known empty is `[]`, not known is absent |
| `flag-synonym` | medium | option | an option is not another name for a vocabulary flag: `--max` and `--take` are `--limit` |
| `identifier-name` | high | key | an identifier key is one from the glossary: `run_id`, never `execution_id` or `log_id` |
| `log-attribute-key` | high | key | no log attribute key on the allow-list names message text, a token or a phone number |
| `missing-run-log` | high | group | the CLI keeps a failed run and reads it back: `runs list`, `runs show`, global `--record` and `--no-record` |

<!-- lint rules: end -->

### Search hierarchy

**Every command whose primary result is a search lives under `search`, then its resource**
(owner, 2026-10-08), as statistics live under `stats`: `search all`, `search messages`,
`search notes`, `search conversations`, `search topics`; for the bot account `bot search messages`.
`search all` covers messages and notes, and a meeting account `--source` names, and is the one an agent
should reach for first. Mail is the knowledge tool's: a source tool has no `search mail`, and `search all`
there never reads mail (owner, 2026-10-14; [TOOL-BOUNDARIES.md](TOOL-BOUNDARIES.md)). A resource's own `search` leaf (`messages search`) does not exist beside it.
`searches` stays: it is the owner's saved searches, a resource, not a search.

### Where a search word is looked for

**Proposed 2026-10-13, awaiting the owner's approval.** A bare word in a search query (`search messages`,
`search all`, `stats messages show`) is looked for everywhere a message holds words: its text, a voice
note's transcript, a word of a file's name, and a file's text. Each hit names the place (`matched_in`:
`text`, `transcript`, `filename`, `file`). One field narrows to one place, and only these:

| Field | Place |
|---|---|
| `text:` / `exact:` | what was written in the message (`exact:` the exact form) |
| `transcript:` | a voice note's transcript |
| `filename:` | a file's whole name (`*` for part of it) |
| `content:` | a file's text |

`--type text|voice|file` filters by the kind of message, not by place. A new place is a new field here
first.

### Statistics hierarchy

**Every command whose primary result is statistics lives under `stats`, then its resource.**
Use the same resource words as elsewhere: `messages`, `chats`, `contacts`, not another word for
the same thing such as `users` or `people`. `show` displays an aggregate report; `top` displays a
ranking. Nest a subresource only when the user selects a distinct subject, as with chat members;
do not add a level for an algorithm, provider or output format. All filters follow the leaf.

The canonical paths for the statistics migration and rankings are:

| Path | Purpose | Status |
|---|---|---|
| `stats messages show [query...]` | Count matching stored messages, with the existing groupings | Planned relocation of `stats messages show` |
| `stats chats show <chat>` | A chat's aggregate numbers for a period | Planned relocation of `stats chats show` |
| `stats chats official <chat>` | What the messenger itself computed for a group or channel it shows its admins: its own period, totals against the previous one, top people, graphs as JSON series. One object, `kind` `group` or `channel`; `--jsonl` refused. Mounted only where `Messenger.officialStats` is set (Telegram) | Added |
| `stats messages top [query...]` | Rank matching messages by a measure or score | Planned |
| `stats contacts top [query...]` | Rank the authors of matching messages by a measure or score | Planned |

A report or chart under `stats` is one JSON object, so `--jsonl` is refused there (`output.one-object`); the
`* evidence` lists stream their items.

These paths specify the command hierarchy, not implemented availability. Existing commands stay
registered until the coordinated migration; no additional statistics commands may be added
outside `stats`. The existing `stats charts` noun view remains under that namespace; review the
planned `stats tasks show` path as part of the same migration inventory. A normal entity card may
contain counts (`contacts info`, `store info`);
that does not make it a statistics command. Its main purpose remains describing the entity.
For bot-account statistics the account namespace comes first: `bot stats <resource> ...`, with
the same meanings wherever the provider supports them; this rule does not add Bot API features.

A relocation moves every caller, page, key and record in the same change and keeps no alias: [WC-CMD-8].

### Before creating a command

The naming pull request answers the questions of [WC-CMD-9] before implementation. For a messenger command it also
checks the [option catalogue](#option-catalogue) before proposing an option, and records the planned paths and
options in the [parity manifest](#the-parity-manifest) before code.

## Agent execution contract

These moved to the handbook: the shared global flags ([WC-CMD-14]), no prompt without a person ([WC-CMD-15]),
declared `effects` ([WC-CMD-17]), the one-shot deadline ([WC-LIFE-5]), when a retry is safe ([WC-OUT-20]),
projection with `--json=a,b` ([WC-OUT-21]) and the output size cap ([WC-OUT-22]).

`commands schema <path...>` describes raw argv inputs, result schemas, effects, permissions, conditional arguments
and safe-retry semantics in JSON Schema 2020-12. Open provider extensions are labelled; a structural schema is not
evidence of complete business validation.

## Option catalogue

Every option of both tools, once: its value, what it means, its default and the commands that take
it. An option means one thing wherever it appears; a new one is added to `parity.json` first, with
its meaning, and this table is regenerated from it. **Bold** marks a clash still to resolve.

<!-- option catalogue: generated by `pnpm parity:render` from parity.json -->

| Option | Value | Meaning | Default | Commands |
|---|---|---|---|---|
| `--about-text` | `<who>` | who sees the about text: everyone, contacts or nobody |  | `account privacy set` (planned) |
| `--accept-terms` |  | accept the model's licence terms, for a model that has its own |  | `models download` |
| `--add` | `<chat>` | put a chat into a folder; repeat it for more |  | `chats folders update` |
| `--after-n` | `<n>` | how many messages after it |  | `messages context` |
| `--agent` | `<agent>` | install the skill for this agent; asks at a terminal, otherwise none |  | `setup` |
| `--ai` |  | call the configured reply model with stored message data; requires reply consent, otherwise uses fallback |  | `replies test` |
| `--all` |  | every row, no paging. **chats requests confirm and reject take every pending request instead — counted against the hourly limit first — so it differs on purpose (Help text rule 4)** |  | `attachments list`, `chats list`, `chats members list`, `chats requests confirm` (planned), `chats requests reject` (planned), `contacts list`, `inbox`, `messages download`, `messages sync`, `review`, `searches history`, `sends list`, `store export`, `store jobs list` |
| `--all-bots` |  | also read every other bot's copy on this machine that read_other_bots allows |  | `bot contacts show` (planned), `bot messages between` (planned), `bot search messages` (planned) |
| `--all-can-pin` | `<on\|off>` | every member may pin messages |  | `chats update` (max, tg only) |
| `--all-in-chat` |  | decide a name in every undecided place of it in the same chat too |  | `mentions confirm`, `mentions reject` |
| `--allow-any-file` |  | send a --file even from credential folders or the tool's own folders |  | `bot api` (planned), `bot messages send` (planned), `messages send` |
| `--allow-chats` | `<ids>` | replace allowed chat ids, comma-separated; empty clears |  | `replies audience`, `replies edit` |
| `--allow-dangerous` |  | go ahead without the question an ask level puts before a deletion |  | `bot chats moderate` (planned), `bot messages delete` (planned), `chats clear` (planned), `chats delete` (planned), `chats moderate`, `messages delete`, `store clear` |
| `--allow-people` | `<ids>` | replace allowed sender ids, comma-separated; empty clears |  | `replies audience`, `replies edit` |
| `--allow-writes` |  | acknowledge that the profile offers writing tools when installing local MCP |  | `mcp add` |
| `--analysis-provider` | `<provider>` | analysis: agent, openai or anthropic |  | `conversations links rebuild` |
| `--analyze` |  | link conversation batches using the configured analysis provider, with remembered chat/provider consent |  | `conversations links rebuild` |
| `--anonymous` |  | nobody sees who voted for what |  | `polls create` (max, tg only) |
| `--answer-model` | `<model>` | only the stored answers this model gave |  | `conversations links clear` |
| `--answer-stdin` |  | with --json and no terminal: print each question as a `needs` line on stderr and read its answer, one line, from stdin |  | `session start` (tg, max only) |
| `--answerer` | `<person>` | stored name, alias, @username, ID or scoped person locator; ambiguous names require a choice; repeat it for more |  | `stats chats newcomers`, `stats contacts responses`, `stats messages unanswered` |
| `--app` | `<how>` | the first time only: how to get this profile's app from my.telegram.org | `browser` | `session start` (tg-only), `setup` (tg-only) |
| `--append` |  | keep existing entries and add the explicitly named one beside them |  | `bot webhooks set` (max-only) |
| `--approval` |  | who joins by it asks first, and an admin lets them in |  | `chats links create` (tg-only), `chats links update` (tg-only) |
| `--as` | `<state>` | how a task is closed: done, or dismissed — it needs no answer |  | `tasks close` |
| `--as-file` |  | send every --file as a plain file to download, a video included |  | `bot messages send` (planned), `messages send` |
| `--as-owner` |  | record a decision as the owner's although an agent's terminal runs the tool |  | `mentions confirm`, `mentions reject`, `tasks close` (planned), `tasks reject` |
| `--as-reply` |  | send as a reply to the matched message |  | `replies edit` |
| `--assignee` | `<person...>` | who does it: sender (whoever sent the task's message) or person:<id>; none clears it. Leave it out when unsure: a task with no assignee is better than none |  | `tasks add`, `tasks update` |
| `--at` | `<HH:MM>` | every day at this local time |  | `attachments jobs install`, `schedule agent` (planned), `schedule command` (planned) |
| `--at-time` | `<time>` | let the messenger send it later, even with this machine off: a local time like 2026-09-25T09:00, or 30m. **schedule agent and schedule command take it for their one run: a duration from now or an ISO 8601 time** |  | `messages send` (max, tg only), `schedule agent` (planned), `schedule command` (planned) |
| `--attachment` | `<n>` | which file of the message, from 1; needed when it has more than one |  | `attachments show`, `attachments update` |
| `--backend` | `<archive\|server\|both>` | where to search: the local archive, the messenger's server, or both (default: both; message discovery uses archive only) |  | `search all` (planned), `search messages` (max, tg only) |
| `--background` |  | run as a job that outlives this command; `store jobs show` follows it |  | `messages sync`, `store gaps repair` |
| `--base-url` | `<url>` | a server with OpenAI's /v1/embeddings: Gemini, Jina, or Ollama and LM Studio on this machine |  | `conversations embed`, `conversations embeddings clear`, `conversations embeddings status`, `conversations links rebuild`, `conversations related`, `conversations status`, `search conversations` |
| `--batch` | `<id>` | the batch id `conversations batches show` printed |  | `conversations links add` |
| `--before-n` | `<n>` | how many messages before it |  | `messages context` |
| `--before-time` | `<time>` | read what came before this time |  | `attachments move` |
| `--block` | `<value>` | Set to `true` if user should be blocked in chat. |  | `bot chats members remove` (planned) |
| `--bot` |  | the bot section of the profile's settings, rather than the personal account's |  | `config set`, `config show`, `config unset` |
| `--bots` | `<profiles>` | also read these bots' copies, comma separated — each allowed by read_other_bots |  | `bot contacts show` (planned), `bot messages between` (planned), `bot search messages` (planned) |
| `--brief` |  | found messages as reference, title, time, sender and excerpt only |  | every command |
| `--by` | `<grouping>` | what to count by. **each command names its own groupings — stats messages show chat, sender, day or hour, and searches create the same for stats messages show --saved; stats chats show day or week, as a series beside its totals — so it differs on purpose (Help text rule 4)** |  | `searches create`, `stats charts`, `stats chats retention`, `stats chats show`, `stats messages show` |
| `--calls` | `<who>` | whose calls ring: everyone, contacts or nobody |  | `account privacy set` (planned) |
| `--can` | `<rights>` | what they may do, comma-separated: read, members, admins, info, pin, link, post, edit, delete. **lists the rights each messenger has — MAX has `read`, Telegram does not — so it differs on purpose (Help text rule 4)** |  | `bot chats admins add` (planned), `chats admins add` (planned) |
| `--caption-above` |  | show the text above the --photo or --file, not below it |  | `messages send` (tg-only) |
| `--catch-up` |  | prepare local search: after this run, or before a search reads it |  | `messages sync`, `search conversations`, `store gaps repair` |
| `--catch-up-chunks` | `<n>` | at most this many local vector chunks |  | `messages sync`, `store gaps repair` |
| `--catch-up-messages` | `<n>` | skip a graph rebuild above this message budget |  | `messages sync`, `store gaps repair` |
| `--catch-up-time` | `<duration>` | time budget for local preparation |  | `messages sync`, `store gaps repair` |
| `--category` | `<name>` | what a task is about, from the list tasks categories prints |  | `tasks add`, `tasks update` |
| `--certainty` | `<n>` | how sure an agent is, 0 to 1, that a task needs nothing more; below the owner's threshold its close waits on the owner |  | `tasks close` (planned) |
| `--channel` |  | a private channel instead of a group; people join it by its link |  | `chats create` |
| `--chart-kind` | `<messages\|active\|membership>` | what to draw: messages, active authors, or joins and leaves | `messages` | `stats charts` |
| `--chat` | `<chat>` | a chat, by id or name; repeat it for more. **chat addressing follows each messenger's supported names, usernames and Saved Messages aliases, so it differs on purpose (Help text rule 4)** |  | `attachments download`, `attachments extract`, `attachments jobs install`, `chats folders create`, `contacts context`, `conversations batches show`, `conversations batches status`, `conversations consents remove`, `conversations embed`, `conversations embeddings clear`, `conversations embeddings status`, `conversations links clear`, `conversations links rebuild`, `conversations rebuild`, `conversations status`, `images embed`, `metadata show` (planned), `metadata sync` (planned), `search conversations`, `searches create`, `stats messages counters show`, `stats messages counters sync`, `stats messages show`, `stats tasks show`, `tags add`, `tags rebuild`, `tags remove`, `tasks link` |
| `--chat-invites` | `<who>` | who may add the account to groups and channels: everyone, contacts or nobody |  | `account privacy set` (planned) |
| `--check` |  | say whether a newer version exists, and install nothing |  | `bot list` (planned), `upgrade` |
| `--checkpoints` | `<durations>` | elapsed joining ages to inspect, such as 1d,7d,30d |  | `stats chats retention` |
| `--chunk-bytes` | `<n>` | maximum source bytes returned from a retained attachment; 1–1048576 | `524288` | `attachments show` |
| `--claim` | `<claim>` | remove only this ownership claim: manual or auto |  | `tags remove` |
| `--close-time` | `<delay>` | it closes by itself this long after sending, like 90s or 5m |  | `polls create` (tg-only) |
| `--closed` | `<on\|off>` | on closes a forum topic to new messages, off reopens it |  | `topics edit` (tg-only) |
| `--comment-to` | `<post>` | comment on this channel post; the comment goes to the post's discussion group |  | `messages send` (tg-only) |
| `--component` | `<name>` | the ranking component whose contributing messages or answer pairs to read |  | `stats contacts evidence`, `stats messages evidence` |
| `--concurrency` | `<n>` | remote: requests at once (default: 4) |  | `attachments extract`, `conversations embed` |
| `--consent-provider` | `<identity>` | exact provider identity from consents list; defaults to every provider |  | `conversations consents remove` |
| `--contact` | `<person>` | the person to tag or untag: their id, @username or name, as the local store knows them |  | `tags add`, `tags remove` |
| `--contacts-only` |  | match only contacts |  | `replies edit` |
| `--context` | `<n>` | messages before and after each hit |  | `search messages`, `searches create` |
| `--correct` | `<n>` | with --quiz: the right answer's position, from 1 |  | `polls create` (tg-only) |
| `--counters` | `<names>` | the counter fields: views,reactions,comments |  | `stats messages counters show`, `stats messages counters sync` |
| `--cursor` | `<cursor>` | continue from the extraction or ranking-evidence cursor |  | `attachments extract`, `chats media` (planned), `contacts events`, `messages comments` (tg, wa only), `messages evidence`, `messages list`, `stats contacts evidence`, `stats messages evidence` |
| `--days` | `<days>` | days of the working window, such as mon-fri or sat,sun |  | `replies edit` |
| `--debug` |  | on a failure, its whole record — cause and stack — in place of the short line |  | every command |
| `--deep` | `<n>` | also check the top n in full — profile, photos, everything they wrote, and the public ban lists, which are sent their ids — one person a second. **TG specializes the SDK help with the bounded Telegram audit; MAX retains the generic SDK wording. Align the shared help with provider capabilities separately; SDK adoption alone does not remove the difference.** |  | `chats members check` |
| `--defaults` |  | change what every profile gets, rather than this profile |  | `config set`, `config unset` |
| `--deny-chats` | `<ids>` | replace denied chat ids, comma-separated; empty clears; deny wins |  | `replies audience`, `replies edit` |
| `--deny-people` | `<ids>` | replace denied sender ids, comma-separated; empty clears; deny wins |  | `replies audience`, `replies edit` |
| `--description` | `<text>` | the new about text — of a chat or of your account. **tasks add and tasks update use Markdown for task details, completion criteria and next steps** |  | `account update`, `chats update`, `tasks add`, `tasks update` |
| `--dims` | `<n>` | remote: the vector size — needed with --base-url; shortens an OpenAI model's |  | `conversations embed`, `conversations embeddings clear`, `conversations embeddings status`, `conversations related`, `conversations status`, `search conversations` |
| `--disappear-after` | `<duration\|off>` | new messages disappear this long after sending: 24h, 7d, 90d; off keeps them |  | `chats update` (planned) |
| `--discover` |  | find partial lexical matches and eligible replies in the local archive; results are evidence, not confirmed answers |  | `search messages` |
| `--do` | `<actions>` | actions: reply, task, or both, comma-separated |  | `replies edit` |
| `--download` |  | first save, from the messenger, the files no download saved yet |  | `attachments extract` |
| `--draft` |  | save the text as a draft for the owner to review and send |  | `messages send` (planned) |
| `--dry-run` |  | judge and plan; do nothing. **A command-specific dry run keeps its richer plan; otherwise the shared shell previews arguments and permissions without running the action. Targets remain unresolved unless that command provides a preview.** |  | every command, `attachments move`, `bot chats moderate` (planned), `chats moderate`, `messages sync`, `stats messages counters sync`, `store clear`, `store repair`, `store reset`, `tags rebuild` |
| `--due` | `<time>` | when a task must be done: an ISO 8601 time or a duration from now; none clears it |  | `tasks add`, `tasks update` |
| `--due-within` | `<duration>` | list tasks due within this: 30m, 2h, 1d | `1d` | `tasks agenda` |
| `--embedding-provider` | `<provider>` | embedding provider: local or openai; flags override profile settings |  | `conversations embed`, `conversations embeddings clear`, `conversations embeddings status`, `conversations related`, `conversations status`, `search conversations` |
| `--emoji` | `<emoji>` | the folder's icon |  | `chats folders create` (planned), `chats folders update` (planned) |
| `--encrypt` |  | compress and encrypt with a password, typed at a hidden prompt or piped on stdin; never kept |  | `store backup`, `store export` |
| `--events` |  | also print edits, deletions and reactions; every line then names its event. **watch updates use this flag independently of the group event --type filter** |  | `bot watch` (planned), `watch` |
| `--every` | `<duration>` | repeat at this interval: 30m, 2h, 1d |  | `schedule agent` (planned), `schedule command` (planned) |
| `--exact` |  | bare words and quotes match their exact form only, as exact:word does; text: still matches every form |  | `search all`, `search messages`, `search notes`, `searches create`, `stats messages counters show`, `stats messages counters sync`, `stats messages show` |
| `--exclude-chat` | `<chat>` | never show this chat in the folder; repeat it for more |  | `chats folders create` (planned), `chats folders update` (planned) |
| `--expected-fingerprint` | `<hash>` | require the whole retained file to match this previous SHA256 |  | `attachments show` |
| `--expire-time` | `<time>` | it stops working then: 2026-09-25T09:00 (local time), or 30m, 2h, 7d from now. **messages pin takes only the lengths its messenger offers, and says how long a pin lasts without it — so it differs on purpose (Help text rule 4)** |  | `chats links create` (tg-only), `chats links update` (tg-only), `messages pin` (wa-only) |
| `--extract` |  | extract text from files mapped by this download |  | `messages download` |
| `--failed` |  | every chat whose newest job failed or died |  | `store jobs retry` |
| `--file` | `<file>` | attach a file; images go as a photo, videos as a video. Repeat it for more |  | `bot messages send` (planned), `messages send` |
| `--filename` | `<name>` | the name others see for the --file, instead of its name on disk |  | `messages send` (tg, wa only) |
| `--filter` | `query` | Strict Lucene filter: any message in the conversation must match; the meaning query stays unchanged. **search notes uses it for a query every note must also match, the meaning half unchanged** |  | `search conversations`, `search notes` |
| `--find-by-phone` | `<who>` | who finds the account by its number: everyone, contacts or nobody |  | `account privacy set` (planned) |
| `--fingerprint` | `<hash>` | refuse if the inspected coverage plan changed |  | `store gaps repair` |
| `--first-name` | `<name>` | your first name |  | `account update` |
| `--for` | `<agents>` | which agents a skill is installed for: claude, agents or all | `all` | `skill install`, `skill show` |
| `--for-everyone` |  | delete for everyone in the chat, not only for you — they cannot get it back |  | `messages delete` |
| `--format` | `<format>` | jsonl, one message per line, or a markdown transcript. **the shared `store export` takes `jsonl` or `markdown`, max's own takes `jsonl` or `md` (e4)** |  | `store export` |
| `--from` | `<who>` | sender to match in `bot search messages` |  | `bot search messages` (planned) |
| `--from-dir` | `<dir>` | read nonrecursive files from this directory for one explicit chat |  | `attachments extract` |
| `--full` |  | found messages with their whole text and every provider field |  | every command |
| `--hidden` | `<on\|off>` | on hides a forum's General topic from the topic list, off shows it |  | `topics edit` (tg-only) |
| `--hide-online` | `<on\|off>` | hide online status and last seen |  | `account privacy set` (planned) |
| `--history` |  | the people added also see the messages from before they came |  | `chats members add` (max-only) |
| `--holder` | `<name>` | who you are for task claims: a session or chat id |  | `tasks agenda`, `tasks claim`, `tasks release` |
| `--html` |  | the text is HTML: <b>, <i>, <a href>, <code> |  | `bot messages edit` (planned), `bot messages send` (planned), `messages edit` (tg-only), `messages send` (tg-only) |
| `--http` |  | serve MCP over HTTP on 127.0.0.1 behind the owner's tunnel, with a one-owner login. **MAX spells out that profile permissions decide; Telegram wording catches up at its next shared SDK adoption** |  | `mcp serve` |
| `--idle` | `<duration>` | stop after this long with nobody using it — 15m, 1h |  | `serve` (max-only), `server restart` (max-only), `server start` (max-only) |
| `--include` | `<kinds>` | every chat of these kinds, comma-separated. **a folder (`chats folders`) or an export folder (`store export`) takes these chats** |  | `chats folders create` (planned), `chats folders update` (planned), `store export` |
| `--into` | `<id>` | the task that stays: a duplicate is merged into it, or a message is linked to it instead of opening a task |  | `tasks add`, `tasks merge` |
| `--join-approval` | `<on\|off>` | people ask to join, and an admin lets them in |  | `chats update` (tg, wa only) |
| `--json` |  | machine-readable output: one JSON value on stdout, nothing else |  | every command |
| `--jsonl` |  | machine-readable output: one JSON object per line, for streaming and jq |  | every command |
| `--kind` | `<kind>` | the kind of link to record; the command lists the supported task and evidence relations |  | `tasks link` |
| `--kinds` | `<kinds>` | chat kinds: dialog, group; comma-separated, empty for any |  | `replies edit` |
| `--last` | `<n>` | stop once the newest n messages are held; not with --since. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `bot messages sync` (max, tg only), `messages sync`, `tasks scan` |
| `--last-name` | `<name>` | your last name |  | `account update` |
| `--last-seen` | `<who>` | who sees when the account was last online: everyone, contacts or nobody |  | `account privacy set` (planned) |
| `--lease` | `<duration>` | how long a task claim lasts, such as 30m or 2h; claiming again extends it | `30m` | `tasks claim` |
| `--left` |  | only the chats this account has left |  | `store clear` |
| `--limit` | `<n>` | how many: rows to show, or messages one run fetches. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `attachments extract`, `attachments list`, `bot chats members list` (max-only), `bot contacts show` (planned), `bot messages between` (planned), `bot messages list` (planned), `bot messages sync` (max, tg only), `bot search messages` (planned), `calls list` (planned), `chats documents list`, `chats links list` (tg-only), `chats list`, `chats media` (planned), `chats members list`, `chats requests list`, `contacts context`, `contacts events`, `contacts list`, `contacts prepare`, `conversations list`, `conversations related`, `images embed`, `inbox`, `mentions domains`, `mentions list`, `mentions places`, `messages comments` (tg, wa only), `messages evidence`, `messages list`, `messages sync`, `metadata sync` (planned), `polls voters` (tg, wa only), `runs list`, `search all`, `search conversations`, `search messages`, `search notes`, `search runs`, `searches create`, `searches history`, `sends list`, `server logs`, `stats chats newcomers`, `stats chats retention`, `stats contacts evidence`, `stats contacts responses`, `stats contacts top`, `stats messages counters show`, `stats messages counters sync`, `stats messages discussion`, `stats messages evidence`, `stats messages show`, `stats messages top`, `stats messages unanswered`, `store gaps repair`, `store jobs list`, `tags rebuild`, `tasks duplicates list`, `tasks list`, `tasks related` |
| `--link` | `<link>` | an invite link: only the requests made through it. **accept and decline take it with --all — one link, worded for each command (Help text rule 4)** |  | `chats requests confirm` (tg-only), `chats requests reject` (tg-only) |
| `--local` |  | use the model on this machine, never the messenger |  | `messages transcribe` (tg, wa only) |
| `--marker` | `<value>` | Marker |  | `bot chats members list` (max-only) |
| `--max-actions` | `<n>` | at most this many actions in one run | `10` | `bot chats moderate` (planned), `chats moderate` |
| `--max-age` | `<duration>` | the observation-age threshold for a fresh counter snapshot |  | `stats messages counters show` |
| `--max-chats` | `<n>` | at most this many chats in one run. **local graph work defaults to 20; opt-in --sync-first network refresh defaults to 5, so help distinguishes the two uses** | `20` | `conversations embed`, `conversations links rebuild`, `conversations rebuild`, `search conversations`, `search messages` (max, tg only), `stats contacts top` (max, tg only), `stats messages show` (max, tg only), `stats messages top` (max, tg only) |
| `--max-chunks` | `<n>` | at most this many chunks embedded in one run | `2000` | `conversations embed`, `conversations rebuild`, `search conversations` |
| `--max-cost` | `<usd>` | stop an agent's run that costs more than this, in US dollars |  | `schedule agent` (planned) |
| `--max-gaps` | `<n>` | maximum interior coverage gaps repaired in this run |  | `store gaps repair` |
| `--max-input-bytes` | `<bytes>` | at most this many bytes of buffered stdin | `16777216` | every command |
| `--max-meetings` | `<n>` | how many of the meeting account's meetings to look through, newest first, or all for every one (default 100) |  | `search all` (planned) |
| `--max-messages` | `<n>` | fetch at most this many messages total (default: 500) |  | `search conversations` (max, tg only), `search messages` (max, tg only), `stats contacts top` (max, tg only), `stats messages counters sync`, `stats messages show` (max, tg only), `stats messages top` (max, tg only) |
| `--max-output-bytes` | `<bytes>` | at most this many serialized bytes of machine data; 0 disables the bound | `4194304` | every command |
| `--max-pages` | `<pages>` | at most this many pages of a list, with a pause between them |  | `chats members check`, `chats members fetch` |
| `--max-subscriber-buffer-bytes` | `<bytes>` | buffer per watcher before disconnecting it; 0 is unlimited |  | `serve` (max-only) |
| `--max-subscriber-total-buffer-bytes` | `<bytes>` | combined watcher buffer budget; 0 is unlimited |  | `serve` (max-only) |
| `--max-tokens` | `<n>` | remote embeddings: bound input tokens; analysis: reserve input and output tokens across this run |  | `conversations embed`, `conversations links rebuild` |
| `--max-uses` | `<n>` | at most this many people join by it, 1 to 99999 |  | `chats links create` (tg-only), `chats links update` (tg-only) |
| `--md` |  | read this messenger's Markdown; see its formatting guide for supported syntax |  | `bot messages edit` (planned), `bot messages send` (planned), `messages edit`, `messages send` |
| `--measure` | `<name>` | the metric used to order a ranking; not with --score or --weights |  | `stats contacts top`, `stats messages top` |
| `--members-see-link` | `<on\|off>` | members may see the invite link |  | `chats update` (max-only) |
| `--mentions-me` |  | require a mention of you or a reply to you |  | `replies edit` |
| `--message` | `<message>` | the message to tag or untag: its id in --chat, or a msg: locator alone |  | `tags add`, `tags remove` |
| `--method` | `<method>` | how to log in when there is no session |  | `setup` |
| `--model` | `<model>` | which model runs analysis, embedding or local speech recognition; the command identifies the applicable model family |  | `conversations embed`, `conversations embeddings clear`, `conversations embeddings status`, `conversations links rebuild`, `conversations related`, `conversations status`, `inbox`, `messages list`, `messages transcribe` — MAX retains its own transcriber and names its model-list command; the shared TG/WA transcriber explains that choosing a model implies local recognition. Both select a downloaded speech model. Align the remaining MAX command when it adopts the shared transcriber., `review`, `search conversations` |
| `--multiple` |  | people may pick several answers |  | `polls create` |
| `--new` |  | what arrived since the last check, each message once — for scheduled runs. **tasks add instead opens the task although tasks that may be the same job were listed** |  | `inbox`, `mentions list`, `review`, `tasks add` |
| `--newest` |  | newest first instead of best first |  | `bot search messages` (planned), `search messages`, `searches create` |
| `--no-approval` |  | anyone with it joins at once |  | `chats links update` (tg-only) |
| `--no-as-reply` |  | send without linking to the matched message |  | `replies edit` |
| `--no-backup` |  | delete the store without backing it up first |  | `store reset` |
| `--no-block` |  | remove without banning; by default a removed person cannot come back by the link |  | `bot chats moderate` (planned) |
| `--no-catch-up` |  | skip local preparation after this run |  | `messages sync`, `store gaps repair` |
| `--no-contacts-only` |  | do not require a contact |  | `replies edit` |
| `--no-hours` |  | clear the working window |  | `replies edit` |
| `--no-input` |  | never prompt or open an interactive login; piped input remains available |  | every command |
| `--no-mentions-me` |  | do not require a mention of you or a reply to you |  | `replies edit` |
| `--no-preview` |  | no preview card for a link in the text |  | `messages send` |
| `--no-question` |  | do not require a question |  | `replies edit` |
| `--no-record` |  | do not keep it, whatever the configuration says |  | every command |
| `--no-registries` |  | do not ask the public ban lists; nothing about them leaves this machine. **TG clarifies that profile and photo reads still use Telegram when public registries are disabled; MAX retains the generic SDK wording. Public registry queries apply to Telegram only.** |  | `contacts check` |
| `--no-serve` |  | do not start it; log in on this command's own connection unless one is running |  | every command (planned) |
| `--notification` | `<text>` | a note only the person who pressed sees |  | `bot callbacks answer` (planned) |
| `--notify` |  | tell the chat's members about the pin |  | `bot messages pin` (planned), `messages pin` (max, tg only) |
| `--ocr` |  | explicitly call models.ocr for bulk image and scanned-PDF text extraction; agents normally transcribe files themselves |  | `attachments extract` |
| `--offline` |  | answer from what was recorded and never connect; fails if nothing was |  | every command |
| `--offset-bytes` | `<n>` | start byte offset in a retained attachment | `0` | `attachments show` |
| `--online` |  | also log in once, read one chat and start the MCP server; sends nothing. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `doctor` |
| `--only` | `<resources>` | only these resources, separated by commas: messages, notes; meetings when --source names a meeting account |  | `search all` |
| `--only-admins-add` | `<on\|off>` | only admins may add members |  | `chats update` |
| `--only-admins-call` | `<on\|off>` | only admins may start a call |  | `chats update` (max-only) |
| `--only-admins-edit-info` | `<on\|off>` | only admins may change the name, photo and description |  | `chats update` (planned) |
| `--only-admins-send` | `<on\|off>` | only admins may send messages |  | `chats update` (planned) |
| `--only-missing` |  | only chats with no metadata yet; without --chat, every stored group/channel |  | `metadata sync` (planned) |
| `--only-owner-edits-info` | `<on\|off>` | only the owner may change the name and photo |  | `chats update` (max-only) |
| `--operation-id` | `<id>` | identify a send or creation attempt; message/poll retries reuse it, while an unknown topic creation must never be repeated |  | `messages forward`, `messages send`, `polls create`, `topics create` (tg-only) |
| `--order` | `<recent\|name>` | newest conversation first, or alphabetical |  | `contacts list` |
| `--others` |  | every session but this one. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `account sessions end` |
| `--output` |  | where to write: a directory for `messages download`, a file for `store export`. **`store export` and other commands use --output for a file; `messages download` takes --output-dir — e10** | `.` | `doctor reports create`, `stats charts`, `store decrypt`, `store export` |
| `--output-dir` | `<dir>` | the folder to write into, created if missing. **`attachments extract` takes it only with --download, and has no default there, so extraction never fills the working folder unasked** | `.` | `attachments extract`, `messages download`, `store export` |
| `--outside` | `<hours>` | answer outside this 24-hour window, such as 09:00-19:00 |  | `replies edit` |
| `--page` | `<n>` | which page, starting at 1 |  | `attachments list`, `attachments show`, `bot search messages` (planned), `chats documents list`, `chats list`, `chats members list`, `chats requests list`, `contacts list`, `mentions domains`, `mentions list`, `mentions places`, `polls voters` (tg, wa only), `runs list`, `search all`, `search messages`, `search notes`, `search runs`, `searches history`, `sends list`, `store jobs list` |
| `--page-size` | `<n>` | how many items one request to the messenger asks for; the messenger's own if not given. **the default is each messenger's own page: 30 on MAX, 100 on Telegram** |  | `bot messages sync` (max, tg only), `messages sync`, `store gaps repair` |
| `--parent` | `<id>` | parent task in the same project; none clears it |  | `tasks update` |
| `--pause` | `<duration>` | the least wait between pages, 5s or 500ms; each is up to twice that. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** | `5s` | `attachments download`, `bot messages sync` (max, tg only), `messages download`, `messages sync`, `store gaps repair` |
| `--per-chat` | `<limit>` | at most this many per chat, such as 1/12h |  | `replies edit` |
| `--per-person` | `<limit>` | at most this many per person, such as 1/1d |  | `replies edit` |
| `--permission` | `<key=level>` | make a permission stricter for this MCP server only, like messages.send=deny; it never loosens the profile; repeat for more keys |  | `mcp add`, `mcp check`, `mcp config`, `mcp serve`, `mcp server start` |
| `--personal` |  | the personal account's section of the profile's settings |  | `config set`, `config unset` |
| `--phone-number` | `<who>` | who sees the number: everyone, contacts or nobody |  | `account privacy set` (planned) |
| `--photo` | `<file>` | an image file — a profile photo in `account update`, a group's photo in `chats update`, a photo to send in `messages send` |  | `account update` — WhatsApp accepts JPEG (.jpg or .jpeg) profile photos; help names each messenger's accepted image formats (WC-CMD-25)., `bot messages send` (planned), `chats update` (planned), `messages send` |
| `--pin` | `<chat>` | pin this chat at the top of the folder; repeat it for more |  | `chats folders create` (planned), `chats folders update` (planned) |
| `--pinned` | `<on\|off>` | on pins a forum topic at the top of the list, off unpins it |  | `topics edit` (tg-only) |
| `--port` | `<port>` | the local port behind the tunnel, for mcp serve --http or bot watch --public-url |  | `bot watch`, `mcp serve`, `mcp server start` |
| `--priority` | `<n>` | task priority from 0 (urgent) through 4 (low) |  | `tasks update` |
| `--problems` |  | only failed responses, warnings and crashes |  | `runs show` |
| `--profile-photo` | `<who>` | who sees the profile photo: everyone, contacts or nobody |  | `account privacy set` (planned) |
| `--public-url` | `<url>` | the tunnel's https address: the browser apps reach mcp serve --http through it, a messenger delivers to bot watch |  | `bot watch`, `mcp serve`, `mcp server start` |
| `--question` |  | match only questions |  | `replies edit` |
| `--quiet` |  | diagnostics off. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | every command |
| `--quiz` |  | a quiz: one answer is right, and a vote is final |  | `polls create` (tg-only) |
| `--read-receipts` | `<on\|off>` | send read receipts |  | `account privacy set` (planned) |
| `--reason` | `<text>` | why a task was closed, kept with it — no-reply-needed, for example |  | `tasks close` |
| `--record` |  | keep this run under `runs`, with the command as typed and secrets hidden; record_input false leaves the typed words out. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | every command |
| `--remind-time` | `<time>` | when to look at it again: an ISO 8601 time or a duration from now; none clears it |  | `tasks add`, `tasks update` |
| `--remove` | `<chat>` | take a chat out of a folder; repeat it for more |  | `chats folders update` |
| `--remove-photo` |  | take a group's photo away; not with --photo |  | `chats update` (planned) |
| `--repair-time` | `<duration>` | time budget for interior archive gap repair |  | `store gaps repair` |
| `--replace` |  | overwrite a saved search of the same name |  | `searches create` |
| `--reply` | `<mode>` | answer all or only listed senders and chats: all, listed |  | `replies audience` |
| `--reply-to` | `<message>` | answer this message id in the same chat |  | `bot messages send` (planned), `messages send` |
| `--retract` |  | take your vote back, where the poll allows it |  | `polls vote` |
| `--revision` | `<n>` | the revision you read before editing |  | `contacts notes edit` |
| `--revote` |  | people may change their vote |  | `polls create` (max, tg only) |
| `--run` | `<id>` | the run the report is about; the newest failed one if not given |  | `doctor reports create` |
| `--saved` | `<name\|id>` | run a saved search, or an earlier run by its id; options typed with it replace its own, more words are AND-ed |  | `search messages`, `stats chats newcomers`, `stats contacts responses`, `stats contacts top`, `stats messages discussion`, `stats messages show`, `stats messages top`, `stats messages unanswered` |
| `--score` | `<helpful\|active\|engaging>` | the named ranking score preset; not with an explicit --measure |  | `stats contacts top`, `stats messages top` |
| `--secret` | `<name>` | keep this secret beside the bot token instead of the token, at a hidden prompt; never from the command line |  | `bot auth set` (planned) |
| `--secret-stdin` |  | a secret MAX sends back in X-Max-Bot-Api-Secret — asked for, or read from a pipe |  | `bot webhooks set` (planned) |
| `--selection` | `<json>` | the versioned resolved ranking selection returned by drilldown; authorisation is checked again |  | `searches create`, `stats contacts evidence`, `stats messages counters show`, `stats messages counters sync`, `stats messages evidence` |
| `--send-as` | `<id>` | send as one of the identities `chats send-as` lists for the chat; required where the chat posts as someone else by default, refused where the messenger has none |  | `messages forward` (max, tg only), `messages send` (max, tg only), `polls create` (max, tg only) |
| `--serve` |  | start `serve` in the background if it is not running (the default) |  | every command (planned) |
| `--server-time` | `<duration>` | stop waiting for the server after this long (default: 5s) |  | `search all` (planned), `search messages` (max, tg only) |
| `--set` | `<id>` | the stickers in this set |  | `stickers list` (planned) |
| `--show-phone` |  | print the whole phone number |  | `account show`, `contacts info` |
| `--silent` |  | deliver without a notification |  | `bot messages send` (planned), `messages forward` (max, tg only), `messages send` (max, tg only), `polls create` (max, tg only) |
| `--since` | `<id-or-time>` | from this message id, an ISO 8601 time, or 2h / 1d ago; each command says its default. **becomes `--since-time` everywhere — NEED-485** |  | `inbox` (planned), `review` (planned) |
| `--since-time` | `<time>` | from this ISO 8601 time, or 2h / 1d ago; each command says its default |  | `attachments download`, `attachments jobs install`, `bot chats moderate` (planned), `bot messages sync` (max, tg only), `chats moderate`, `contacts context`, `contacts prepare`, `messages sync`, `replies test`, `search conversations`, `stats charts`, `stats chats newcomers`, `stats chats retention`, `stats chats show`, `store export` |
| `--size` | `<n>` | messages to answer per batch, 10–200; 50 by default |  | `conversations batches show`, `conversations batches status`, `conversations links rebuild` |
| `--skip` | `<which>` | a folder leaves out chats that are muted, read or archived |  | `chats folders create` (planned), `chats folders update` (planned) |
| `--sms` |  | phone login: ask Telegram to send the code by SMS, not to the app; Telegram may still refuse |  | `session start` (tg-only) |
| `--solution` | `<text>` | with --quiz: what people see once they answered |  | `polls create` (tg-only) |
| `--source` | `<accounts>` | which accounts: personal, bots or all, a provider, or a list of provider:account as a hit shows it, a provider, a kind (messages, mail, notes, documents, meetings) or group:<name> — the same as in: in the query. **each search reads the accounts of its own kinds and names the rest in skipped — source-everywhere-plan.md** |  | `search all` (planned), `search conversations`, `search messages`, `search notes` (planned), `searches create`, `stats contacts responses`, `stats contacts top`, `stats messages counters show`, `stats messages counters sync`, `stats messages discussion`, `stats messages show`, `stats messages top`, `stats messages unanswered` |
| `--spoiler` |  | hide the --photo or video behind a spoiler until tapped |  | `messages send` (tg-only) |
| `--start` | `<param>` | the start parameter the bot or app reads; for chats start, a link's own ?start= when not given |  | `chats app` (planned), `chats start` (planned) |
| `--sticker` | `<id>` | send this sticker, alone; stickers list finds its id |  | `messages send` (planned) |
| `--sticker-file` | `<file>` | send a .webp file as a sticker, alone, with no text |  | `messages send` (planned) |
| `--store-token` | `<profile>` | keep a returned authentication token only in this bot profile's OS keyring; never print it |  | `bot api` (planned) |
| `--sync-first` |  | first fetch new messages within the chat, time and message bounds |  | `bot contacts show` (planned), `contacts context` (max, tg only), `search conversations` (max, tg only), `search messages` (max, tg only), `stats contacts top` (max, tg only), `stats messages show` (max, tg only), `stats messages top` (max, tg only), `tags rebuild` |
| `--sync-time` | `<duration>` | stop fetching after this long (default: 30s) |  | `search conversations` (max, tg only), `search messages` (max, tg only), `stats contacts top` (max, tg only), `stats messages counters sync`, `stats messages show` (max, tg only), `stats messages top` (max, tg only) |
| `--task` | `<id>` | a task, by its id or key as tasks list shows it |  | `tags add`, `tags remove` |
| `--template` | `<text>` | the reply template |  | `replies edit` |
| `--template-mode` | `<mode>` | legacy template mode: fill-only or may-reword; use ai blocks instead |  | `replies edit` |
| `--text` | `<text>` | the message's new text; - reads stdin |  | `bot callbacks answer` (planned) |
| `--text-file` | `<path>` | read the text from this file; - or none reads stdin |  | `attachments update`, `contacts notes add`, `contacts notes edit` |
| `--thread` |  | the stored reply chain and replies instead of time neighbours; falls back when no graph exists |  | `messages context`, `search messages` |
| `--thread-bytes` | `<n>` | at most this many bytes of whole messages and links in each context (default: 65536) |  | `messages context`, `search messages` |
| `--thread-hops` | `<n>` | at most this many links from the hit (default: 8) |  | `messages context`, `search messages` |
| `--thread-messages` | `<n>` | at most this many messages in each thread context (default: 50) |  | `messages context`, `search messages` |
| `--thread-within` | `<duration>` | messages within this long either side of the hit (default: 1d) |  | `messages context`, `search messages` |
| `--threads` | `<n>` | threads in all | `min(8, cores)` | `conversations embed` |
| `--timeout` | `<duration>` | give up on the whole command after this — 30s, 2m, 500ms |  | every command |
| `--timezone` | `<zone>` | the IANA timezone for calendar date boundaries. **replies edit uses this option for the IANA timezone for the working window** | `system IANA timezone` | `attachments jobs install`, `replies edit`, `search all`, `search conversations`, `search messages`, `search notes`, `searches create`, `stats charts`, `stats chats newcomers`, `stats chats retention`, `stats chats show`, `stats contacts responses`, `stats contacts top`, `stats messages counters show`, `stats messages counters sync`, `stats messages discussion`, `stats messages show`, `stats messages top`, `stats messages unanswered` |
| `--title` | `<title>` | the new name — of a chat, a folder or a forum topic. **tasks add and tasks update use this for the action and its object, in one line** |  | `bot chats admins add` (planned), `chats folders update`, `chats update`, `tasks add`, `tasks update`, `topics edit` (tg-only) |
| `--to` | `<chat>` | the chat to forward it to: an id, or part of a chat name. **the sentence says how to name a chat the messenger's way, so it differs on purpose (Help text rule 4)** |  | `messages forward` |
| `--topic` | `<id>` | address this forum topic: send or forward to it, read only it, or mark only it read. **Telegram group forums only; MAX explicitly refuses this option before sending** |  | `chats mark-read` (tg-only), `messages forward` (tg-only), `messages send` (tg-only), `polls create` (tg-only) |
| `--trace` |  | one line per request on stderr: ids and timings, never message content. **max logs one line per request, tg the connection's own lines: the same option, a different mechanism (Help text rule 4)** |  | every command |
| `--track` |  | also do it daily while serve runs |  | `chats members fetch` |
| `--transcribe` |  | hear voice messages not heard yet, on this machine; slow, the model must be downloaded. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `inbox`, `messages list`, `review` |
| `--type` | `<names>` | only these types. **each command names its own types — tasks add gives the new task question, request, mention or promise — so it differs on purpose (Help text rule 4)** |  | `chats media` (planned), `stats tasks show`, `tasks add` |
| `--types` | `<value>` | Comma separated list of update types your bot want to receive |  | `bot watch` (planned), `bot webhooks set` (planned) |
| `--unanswered` | `[duration]` | only questions to you or a group's admins that nobody answered, asked at least this long ago — 4h, 1d. **max's own `review` still takes bare hours until T6 moves it (e2)** | `24h` | `review`, `tasks agenda` |
| `--until` | `<time>` | only until then: a local time, or a duration from now |  | `chats mute` (planned) |
| `--until-id` | `<id>` | only up to this message id, inclusive; the newest by default. **tg's `bot messages sync` takes a message link here, the message the sync starts at, inclusive** |  | `bot messages sync` (tg-only), `chats mark-read` |
| `--until-time` | `<time>` | through this ISO 8601 time, or 2h / 1d ago |  | `stats chats newcomers`, `stats chats retention` |
| `--upgrade` |  | explicitly upgrade a basic group to a supergroup before enabling topics; its chat id changes |  | `topics enable` (tg-only) |
| `--verbose` |  | more detail in what is shown: -v ids, -vv everything known | `0` | every command |
| `--version` |  | print the version number |  | every command |
| `--voice` | `<file>` | send an Ogg Opus file as a voice message, alone, with no text |  | `bot messages send` (planned), `messages send` |
| `--waiting` | `<duration>` | only chats where the owner wrote last at least this long ago | `7d` | `tasks agenda` |
| `--weights` | `<json>` | the complete ranking component weights; replaces preset weights when --score is given |  | `stats contacts top`, `stats messages top` |
| `--with-notes` |  | include your private notes, subject to contacts.notes.list permission |  | `contacts show` |
| `--within` | `<duration>` | the observation window after a known join; each report names what it measures |  | `stats chats newcomers`, `stats chats retention`, `tasks agenda` |
| `--words` | `<words>` | match any of these whole words, comma-separated; empty clears |  | `replies edit` |
| `--yes` |  | go ahead without the question an ask level puts before a write |  | every command, `account sessions end` (planned), `mcp config` (planned), `mcp serve` (planned) |

<!-- end of the option catalogue -->

## Bounded read batches

`batch <file>` reads a JSON file, or stdin when input is `-`. It dispatches only explicitly registered
read handlers; it is not a shell or arbitrary command runner. Each request is `{id, command, args}`,
with a unique bounded id, a command-path array and a string argument array. Discovery/help name the
registered paths. All shapes and arguments validate before opening a selected account/store.

Inputs keep independent normal answers, continuation cursors, fingerprints, coverage and errors. The
host fixes one account/store lifetime; no request can select another account. Meeting word search and
passage reads are the first handlers. A batch performs one bounded index pass before word searches;
it neither merges rankings nor deduplicates overlapping passages. It never invokes a remote model.

Base owns bounded input, correlation and serial orchestration. Core owns the registered meeting
handlers, existing single-input grammar/answers and account-scoped read adapter. Hosts own file/stdin
ports, authorization, resource close and final output. Single-input commands keep their shape/behavior.

Caps are 32 inputs, 256 KiB input, 64 MiB reserved stored-text read ceilings and 4 MiB rendered output.
Indexing reserves 4 MiB once. Each read reserves its own requested ceiling before calling the store;
failed reads never refund it. These are conservative ceilings, not measured consumption or SQLite/disk
I/O. Every refused input remains correlated as not_run. An input whose answer exceeded its output
allowance is error; later inputs are not_run. Projection applies before retained-result accounting,
inside each normal answer, preserving id, command, status and error.

JSON is the standard list envelope of correlated results, each with status ok/error/not_run and complete.
JSONL uses one item record per result and one standard end record. A batch declares partial semantics:
valid per-input failures exit 0 with meta.complete false and issues; malformed whole requests exit 2.
Outer cancellation/deadline, store-close and final writer failures retain the host's normal fatal
handling; they never emit a false complete end. Text/Markdown reuse compact passage presentation,
with coverage once per result. Budget defaults and partial status must remain the same across hosts.

## Output

Envelopes, keys, errors and exit codes are on the handbook's [output](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/output.md) page: one envelope per answer
([WC-OUT-4] to [WC-OUT-7]), at most two next steps ([WC-OUT-9]), a write's `operation_id` ([WC-OUT-10]), the
same shape for a shared command, with what one messenger alone knows under `provider_metadata` ([WC-OUT-11]),
snake_case keys ([WC-OUT-12]), and the error object and exit codes ([WC-OUT-14] to [WC-OUT-19]). The rules below
are the messenger CLIs' own; they keep their numbers, so a citation of one still finds it.

`watch --jsonl` emits canonical snake_case messages inside `{ "type": "item", "data": … }`.
With `--events`, `data.event` names the change and message/edit events carry `data.message`.
Read `data` instead of the former raw line. Live counter observations remain under
`counter_observations`; attachment provider references are never printed. A normal stop or timeout
ends with one `type: "end"` record and `complete: true`. A source failure ends incomplete and exits
nonzero, with the normal error on stderr. A closed pipe, disconnected relay client, forced second signal or output cap may
prevent the end record: readers must treat its absence as a cut stream. `watch --json` is refused.
The SDK's listener event objects keep their existing shape. `serve` declares its final summary
separately as `serve_summary`.

- **`inbox` and `review` are not lists**: they answer one view grouped by chat, `{ chats: [{ …, messages }] }`, in
   every messenger CLI.

6. **`server status` answers one shape in every messenger CLI** (NEED-494 B). Not running is a result,
   `running: false`, exit 0.

   | Field | Meaning |
   |---|---|
   | `profile` | the profile asked about |
   | `running` | a server answers for it |
   | `pid` | its process |
   | `started_at` | when it started |
   | `connected` | logged in, with updates arriving |
   | `connected_at` | since when, where the tool knows it |
   | `by` | who started it: `unit` (systemd or launchd), `server` (`server start`), `hand` (`serve` typed in a terminal), `command` (max: a command that needed it) |
   | `version`, `cli_version` | what the server runs, and what this tool is — they differ after an update, and a note on stderr says `server restart` |
   | `log` | where its log is |
   | `unit` | `{ name, path, installed, loaded, active, detail }` |
   | `stale` | `{ pid, started_at }` — a lock or socket file was left by a server that is gone |

   Starting and stopping in the background is `server start` and `server stop` only; `serve` is
   the foreground command a unit or a person runs.

7. **A message search says which hits it forgave** (owner, 2026-10-13, option B of
   [the typo plan](typo-search-default-plan.md)). Strict search runs first and its hits come back
   unchanged. Only when it finds nothing does a plain word that is not a whole archive word get
   help: a known beginning of three or more letters matches as a prefix, an unknown word matches
   the archive words one edit away. Explicit syntax, phrases, fields, exclusions, an AST and `--exact`
   stay strict.
   - **`match` on a hit says how it matched.** A strict hit has no `match`. A forgiven hit has
     `match: "corrected"` or `match: "beginnings"`; when both helped, `corrected` wins, since a
     correction can turn a real word the archive lacks into another one. These are values the
     `Match` type already has; no list of labels goes beside it.
   - **`corrections` on the answer says what was searched instead of what was typed**:
     `[{ from, to }]`, `from` the typed word, `to` the archive words searched for it. It lists only
     corrections behind a returned hit, and is `[]` otherwise. A beginning is not a correction and
     is not listed. The CLI prints each one as a note on stderr, `from → to`.
   - **Nothing found points at `--discover`.** Partial matches stay opt-in. When the forgiving step
     also finds nothing, the MCP answer adds a sentence naming `discover=true` to the tool's
     existing `next_steps` string, and the CLI writes one line to stderr naming `--discover`. No new
     key; stdout stays data. `search all` names `search messages --discover`, the one command that
     has it.
   - **`--exact` turns forgiveness off.**
8. **A search says which accounts it read** ([source-everywhere-plan.md](source-everywhere-plan.md)).
   Every stored thing has a kind (`messages`, `mail`, `notes`, `documents`, `meetings`), a provider
   and an account; `--source` takes `provider:account`, a bare provider, a bare kind or
   `group:<name>`, and a positive `in:` a bare provider or kind. `search all`, memo's `search mail` and `search notes` answer
   `accounts: [{ resource, provider, account }]` beside `searched` and `skipped`; `search messages`
   answers the same list as `coverage.accounts`. A `--source` entry a search cannot use is named in
   `meta.issues` as `{ code, source }`, its reason on stderr. A hit's `provider:account` is a valid
   `--source` entry.
9. **A hit that has a page elsewhere answers its `url`** (planned, same plan): a Google Drive document's
   Google link. `url` is absent, not `null`, where there is none; meetings and attachments use the same key.

## Resumable syncs

These moved to the handbook's [lifecycle](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/lifecycle.md#resumable-syncs)
page: a long sync saves its work per item or per page ([WC-LIFE-12]), a rerun goes on from where the last run stopped
([WC-LIFE-13]), and its status command says how far it is in one shape ([WC-LIFE-14]). cli-core provides
`saveCheckpoint`, `readCheckpoint`, `progressOf` and `progressLine` in `@wirecat/cli-core/background`.

## Permissions

The setting, its levels, keys, defaults and hard limits are on the handbook's [permissions](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/permissions.md) page:
`permissions` as the only access setting ([WC-PERM-1]), the four levels ([WC-PERM-2]), keys and the most specific
one ([WC-PERM-3]), the commands checked as `messages` ([WC-PERM-4]), housekeeping ([WC-PERM-5]), the built-in
defaults ([WC-PERM-6], [WC-PERM-7]), the limits no level lifts ([WC-PERM-11]) and a bot's keys
([WC-PERM-20]). The write guard every write passes is [WC-PERM-13] to [WC-PERM-18]: the recipient list (which
chats), `sends_per_hour` (how many), the send journal and the flood hold. Stricter here than WC-PERM-18: the hold stops
every write, a reaction and a read receipt too, and a ban with no known end holds until `flood clear` or a
`doctor --online` that finds the account well. What stays here:

5. **A group's moderation rules use the same four levels** for each kind of action (delete,
   remove, accept, decline), `readonly` meaning "report it, do nothing". A rule's level can only be
   as loose as the profile's level for `chats.moderate`.

7. **Housekeeping under `bot` is never gated**: `bot auth`, `bot list`, `bot recipients`, `bot sends`, `bot mcp`.

## Retention and counter observation contract

The owner approved the retention and counter observation contract
on 2026-10-08. Retention is a chat report; counters is a distinct subresource of messages.
Counter refresh is an explicit bounded remote read and local write; ordinary statistics remain
stored reads. Snapshot times and unknown denominators are exposed, never inferred from ingestion.

## Administrator statistics contract

The owner approved the four stored-data report views and option meanings in the
admin statistics contract on 2026-10-08.
They are implemented by the shared stats service. Reports use explicit reply evidence and preserve
unknown history and join times. They share the existing stats namespace and MCP frontend.

## Planned ranking contract

The owner-approved ranking views and their options are recorded in the
ranking command contract. Rankings operate on
stored messages under `stats messages top` and their human authors under `stats contacts top`;
ordinary search does not gain ranking modes. The owner also approved `stats messages evidence`
and `stats contacts evidence` for bounded component drilldown on 2026-10-07. The manifest
labels all feature paths and options as planned until implementation.

## MCP

The three tools, their arguments and what each permission shows are on the handbook's [MCP](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/mcp.md) page
([WC-MCP-1] to [WC-MCP-10]), the bot server's three included. What stays here is cli-core's own:

- `status` answers what the server is. `conversations refresh` runs what `search conversations --refresh` runs before
  it searches (NEED-551 A).
- **Every command is a tool, writes included; the profile's permissions limit it** (owner, 2026-10-23). Left out:
  `mcp` (with `mcp serve`) and `complete`, which an agent call cannot use, and interactive login (`bot auth` too). Finite
  commands remain discoverable even when permissions block execution; availability explains the restriction.
- **The writes no level stopped before have keys of their own, `ask` by default** (NEED-1663 A), so MCP offers them
  and over MCP they go ahead as any `ask` write: `store backup|restore|migrate|repair|reset|clear|decrypt` and
  `store copies delete` (`store.<command>`), `server start|stop|restart`, `models audio|text download` and `images
  models download`, `schedule run|exec`, `doctor report create`, `account sessions end`, `chats delete|clear`, and
  `bot messages sync`. The key is the command's path; `deny` or `readonly` marks the command unavailable without hiding it. `store reset|clear|decrypt`
  are still stopped by `deny messages` too. On the command line nothing changes: these commands ask no new question.
- **A command that changes what a later run may do requires `mcp.authority` to execute** (NEED-1662 B): `config
  set|unset`, `schedule command|agent|remove`, `replies` rules, pause and consents, `recipients add|remove|clear`
  (the bot's too), `chats rules set|unset` (the bot's too), `server install|uninstall`, `attachments jobs
  install|start|stop|uninstall`, `skill install`, `models text key set|remove`, `flood clear` — every command
  marked `grantsAuthority`. The key is `deny` by default, and a broader `mcp: allow` does not lift it; at `deny` or
  `readonly` discovery retains these commands with `available: false`, a reason and the key. Execution is refused
  with an error naming the key. The owner turns it on in a terminal — `<cli> <profile> config set
  permissions.mcp.authority allow`, with `--bot` for a bot server. Discovery and execution read current permissions. An agent never changes
  the key itself: `config set|unset` run over MCP refuses `permissions.mcp…` and a whole `permissions` that names
  it, on any profile and in the defaults. `<PREFIX>_READ_ONLY` still refuses them all (SEC-47).
- **`bot api` execution requires `bot.api`** (NEED-1679 B): its calls go to the messenger's Bot API as they are
  given, so they skip the send guard and the bot's recipient list. The key works as `mcp.authority` does: `deny` by
  default for an MCP server, a broader `bot: allow` does not lift it, at `deny` or `readonly` the commands remain
  discoverable with their availability reason, and execution is refused naming the key. The owner enables it with
  `<cli> <profile> config set --bot permissions.bot.api allow`. An agent never changes the key: `config
  set|unset` run over MCP refuses `permissions.bot.api` and a whole `permissions` that names it. Each operation is a
  tool with the operation's effect (a read or a write), so `<PREFIX>_READ_ONLY` marks the writes unavailable and refuses them. The command line's
  `bot api` is not held back by the key; the CLI keeps checking `bot.api.<operation>` as before.
- **The first-run answer caps every profile of every WireCat tool** (TASK-757, NEED-1676). Before the first command
  at a terminal, a tool asks what no WireCat tool has asked yet — languages (written to the store's
  `search_stemmers`; a new store ticks the tool's `AppIdentity.contentLanguages` that search can stem, else English
  and the system's language, and only the answer writes the setting), other tools to install, and what commands and agents may do — and keeps the answers in the
  `setup` section of the shared `~/.config/WireCat/config.json`. "Read only" puts the `*` key at `readonly` among a
  profile's levels: `levelFor` never returns a level above it, so it holds over a profile's own `allow`, over MCP
  and over `--permission`. A config file cannot name `*`; only the question at a terminal writes it, and an
  unreadable `setup` section counts as read-only. Nothing is asked of a run that is not a person at a terminal
  (machine output, `--no-input`, `CI`, a pipe, `AI_AGENT` or `CLAUDECODE` set), of a process under
  `<PREFIX>_READ_ONLY`, or before `help`, `guide`, `completion`, `mcp`, `serve`, `server`, `update` and `store`;
  `setup` asks all three again, so the owner changes an answer there. A failed question never stops the command typed. Changing the languages of a store in use rebuilds its
  word forms at once, after the owner agrees, since word search refuses until they are rebuilt.

`stats charts --output` selects SVG or PNG by the file extension; images never go to stdout.
The stored-only `stats_charts` tool accepts optional `format: json|png` (default `json`).
PNG adds `image/png` content and JSON text `{ chart, image: { format, width, height } }`;
it writes no file and uses the same `messages` read permission.

## Help text

How help and scoped discovery are written is on the handbook's [commands](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md) page ([WC-CMD-22] to
[WC-CMD-26]). The messenger CLIs keep these numbers:

1. **A description says what the command does, as the user sees it**: [WC-CMD-23].
2. **A shared command has the same sentence in every messenger CLI**: [WC-CMD-25]. The shared factory writes the
   description, and a CLI changes it only to name its messenger.
3. **An option's description says what it changes and its unit**: [WC-CMD-22].

4. **A shared option has one sentence in both tools**, checked by the parity workflow
   (`cli-core-parity wording <max.json> <tg.json>`; each file is known by its `cli`, so it takes
   any number, in any order). A difference is allowed only where the sentence names something the messenger's own way — how to name a chat, which rights or events it
   has — and the option's catalogue `note` says so; a note also marks a difference still open, and
   names who closes it.

## Layers and sharing

The layers, the direction of dependencies and what goes in which package are on the handbook's
[architecture](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/architecture.md) page: call only the layers below ([WC-ARCH-1]), no vendor type above the adapter
([WC-ARCH-3]), the lowest shared package that can hold the code ([WC-ARCH-4]), a feature another messenger could
have as a shared command behind a capability ([WC-ARCH-5]), and replacing a use case, not a command
([WC-ARCH-6]). The local [architecture map](ARCHITECTURE.md#responsibility-and-dependency-boundaries) names
cli-core's modules.

## Documents

1. **Each user page of max has a tg page on the same question**, at the same depth: installing,
   using, configuring, security, troubleshooting, diagnostics, groups. max's pages are Russian,
   tg's English.
   Both follow the docs site's page set (WireCatLabs/cli-docs `docs/STRUCTURE.md`): `index.md` is the
   site's short start page, `archive.md` the local store, `roadmap.md` what is coming. Pages one tool
   has alone, and why:
   - max `bot.md` — tg has no bot side yet; its page comes with it (P8).
   max's reverse-engineered protocol is `docs/dev/protocol.md`, a developer page, not a user one.
2. **The README is the full introduction, and max's is the model.** Users read it first, so it is
   not cut down to a landing page. Both READMEs have these sections in this order: the bot, the
   personal account, how to use it, groups you run, how it works, what it can do, why it is good,
   custom work, how it differs, contents, install, log in, use, for scripts and agents, security,
   documentation, development, roadmap, licence, contributing.
3. **A change to a command changes its page in both tools** in the same docs pull request.
4. **A page names only options that exist or are planned.** Each CLI's CI runs
   `<cli> commands --json | cli-core-parity <cli> --pages README.md docs/*.md`: an option a user
   page puts on a command must be on that command, or be in this manifest for it and not only for the
   other tool. A change that drops an option fails until its pages stop naming it.

## The parity manifest

`parity.json`, shipped in this package, lists every command path and option of every tool. Its
`clis` names them (`["max", "tg", "wa"]`). Each CLI's CI checks its own `commands --json` against its
column of the manifest in the version of this package it installed (`pnpm parity:check`).

Each row says which CLIs have it:

```json
"messages list": { "in": "all" },
"polls":         { "in": ["max"], "reason": "Telegram polls are …" },
"store clear":   { "in": ["tg"], "planned": { "max": "T6" } }
```

| Field | Meaning | What `parity:check` checks for a CLI |
|---|---|---|
| `in` | `"all"`, or the CLIs from `clis` that have it | listed: present in this tool |
| `planned` | a CLI outside `in` → who closes the gap (a workstream) | planned: nothing — present or absent both pass |
| `reason` | why the CLIs neither in `in` nor planned lack it; required when there are any | neither: absent in this tool |

An option is the same object, or the bare string `"all"`. A row only one CLI has, with a `reason`,
covers every path below it. A row with `"subtree": true` and a plan does the same, for a whole
command tree a tool has yet to build: `bot` is one row.

**A new CLI joins with one command:** `pnpm parity:seed --cli <name>` adds it to `clis` and plans
every row and option for it, by `"?"`. Its parity check passes from its first pull request, and the
gaps stay listed. Its author then narrows the rows:
moves the CLI into `in` where it has the command, names who closes each plan, and gives a reason where
it never will. `pnpm parity:seed <commands.json...>`, one file per CLI, adds the rows the CLIs have
and the manifest lacks; a row already there is never changed.

**How a new command or option reaches CI without a release of this package per row.** The docs
pull request that introduces it adds its row as planned, here, before any code. Planned passes
whether the command exists or not, so the code pull request in any CLI lands on the manifest
already released. The flip to `in` goes into the next release of this package with whatever else
it carries; a row is never the only reason for a release.

**A row puts a CLI in `in` only when that tool has it on its own `main`.** A shared command that one
CLI does not use yet — max keeps its own `messages edit` until it moves onto the shared one — stays
planned for it, by the workstream that moves it. So does an option a CLI still has and is about to
drop. Flipped early, the row fails that CLI's `parity:check` on its next upgrade of this package and
blocks the upgrade.

**This repository checks every tool's `main` against its own manifest** (`.github/workflows/parity.yml`):
by hand, and inside full validation (`ci.yml`), which each pull request, each push to `main`, the release and
the monthly run start. There is no daily run. It
builds tg-cli, max-cli and whatsapp-cli from their `main` and runs the same check, so a row flipped early fails
here, before the release that would carry it — not weeks later, when a CLI upgrades. The wording job compares
max and tg only, until wa's own `setup --method` says what theirs says. The published
CLIs are not the reference: a release always trails `main`, so they lag every row that gains a CLI.
A new CLI is added to the workflow's matrix and its wording job when its repository exists.

**The milestone audit is one command:** `pnpm parity:audit --fresh` clones and builds every tool's
`main` and prints, besides the manifest's state, what CI does not fail on: the shared version each
tool pins, the MCP tools each offers, the user pages and their headings, the README sections, and the
release and QA scripts and skills. Each MCP server starts in an empty temporary home, so nothing
reaches Telegram or MAX. `--max <dir> --tg <dir>`, one option per CLI in `clis`, uses checkouts already
built.

## Search preparation and archive gaps

Approved2026-10-07. These additive shared surfaces are implemented in the search follow-up plan.

- `attachments extract --from-dir <dir>` reads a nonrecursive directory for one explicitly named
  `--chat`; it cannot be combined with `--download` or `--output-dir`. MCP `attachments_extract`
  uses `from_dir`, `download`, `output_dir` and `limit`, matching CLI semantics. A bounded
  scan returns `cursor`; pass it as MCP `cursor` or CLI `--cursor` to continue.
- `messages download --extract` extracts only the files this download mapped to stored attachments.
- Per-profile `search_catch_up` defaults to false. `messages sync --catch-up` or `--no-catch-up` overrides
  it; `--catch-up-chunks`, `--catch-up-messages` and `--catch-up-time` bound local preparation.
  Defaults are500chunks,10,000messages and30seconds for the fetched chat. It never downloads a model
  or activates a remote embedding/analysis provider.
- `store gaps plan <chat>` inspects recorded coverage locally. `store gaps repair <chat>` explicitly
  fetches interior gaps; `--max-gaps`, `--limit`, `--repair-time`, provider `--page-size` and `--pause`
  bound the operation. `--background` uses existing jobs. MCP names are `store_gaps_plan` and
  `store_gaps_repair`; options use underscores. Defaults are5gaps,500messages and30seconds.
- Local extraction/preparation require their write permissions. Gap repair requires permission for
  its explicit fetch. A dry plan is read-only; gaps never authorize deletion or weaker rate limits.

## Attachment OCR

Approved2026-10-07. Contract: agent self-OCR
and `attachments text set` are the default. `attachments extract --ocr`
explicitly selects gateway API OCR for bulk extraction using models.ocr;
`--concurrency` retains its remote-request meaning, default4, range1–8 here, and
requires --ocr. Existing local extraction without --ocr never invokes a model.
MCP uses the same service and explicit selection. Local paths do not transfer
files to remote agents; binary/artifact transport remains separate.

## Local attachment document readers

Reader contract: UTF-8/BOM and bounded
high-confidence legacy decoding; ODT/ODS/XLSX/PPTX/EPUB digital text, using the existing
extract/text/index commands. No remote model call for locally readable files, including
an explicit --ocr run. Generic archives, legacy Office and RTF remain external conversion.
Agent text and previous good text survive automated failures; no partial structured text
is indexed as a complete result. Existing PDF/Word optional packages remain optional.

[WC-ACCT-1]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/accounts.md#wc-acct-1--name-the-profile-on-every-command-that-acts-for-an-account
[WC-ACCT-3]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/accounts.md#wc-acct-3--a-missing-profile-is-an-error-that-lists-the-choices
[WC-ARCH-1]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/architecture.md#wc-arch-1--call-only-the-layers-below-you-interface-then-service-then-port-then-adapter
[WC-ARCH-3]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/architecture.md#wc-arch-3--only-the-adapter-imports-a-vendor-library-nothing-above-it-sees-a-vendor-type
[WC-ARCH-4]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/architecture.md#wc-arch-4--put-code-in-the-lowest-shared-package-that-can-hold-it
[WC-ARCH-5]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/architecture.md#wc-arch-5--build-a-feature-that-another-provider-could-have-as-a-shared-command-behind-a-capability
[WC-ARCH-6]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/architecture.md#wc-arch-6--replace-a-use-case-not-a-command
[WC-CMD-1]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-1--build-every-path-as-resource-first-then-a-verb-or-a-view
[WC-CMD-2]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-2--take-every-verb-view-resource-and-root-word-from-the-cli-base-vocabulary
[WC-CMD-4]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-4--add-a-root-word-only-when-no-resource-or-namespace-can-hold-the-command
[WC-CMD-6]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-6--give-one-action-or-one-report-one-leaf-command
[WC-CMD-7]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-7--never-let-two-commands-overlap
[WC-CMD-8]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-8--keep-no-aliases-a-renamed-path-stops-working-in-the-release-that-renames-it
[WC-CMD-9]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-9--answer-the-naming-questions-in-the-pull-request-before-you-build-a-new-command
[WC-CMD-10]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-10--use-a-vocabulary-flag-for-its-meaning-and-give-one-flag-one-kind-of-value-everywhere
[WC-CMD-13]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-13--name-arguments-with-a-singular-noun-of-the-thing-they-take
[WC-CMD-14]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-14--keep-the-shared-global-flags-at-their-meaning
[WC-CMD-15]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-15--never-prompt-when-no-person-can-answer
[WC-CMD-17]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-17--declare-effects-on-every-command
[WC-CMD-22]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-22--describe-every-command-argument-and-option-with-a-summary-of-at-most-80-characters
[WC-CMD-23]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-23--write-help-as-the-user-sees-the-command-one-line-lower-case-no-full-stop-no-internal-term
[WC-CMD-25]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-25--give-a-shared-command-and-a-shared-option-the-same-sentence-in-every-cli-of-its-group
[WC-CMD-26]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-26--print-the-command-tree-with-cli-bases-commandsdocument-and-keep-every-key-snake_case
[WC-CMD-28]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/commands.md#wc-cmd-28--use-the-external-command-line-references-as-a-baseline-and-keep-the-projects-choices-where-they-differ
[WC-LIFE-5]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/lifecycle.md#wc-life-5--bound-every-one-shot-command-by-a-deadline
[WC-LIFE-12]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/lifecycle.md#wc-life-12--save-a-long-syncs-work-per-item-or-per-page-so-a-kill-loses-nothing-saved
[WC-LIFE-13]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/lifecycle.md#wc-life-13--a-rerun-goes-on-from-where-the-last-run-stopped-and-starting-over-is-an-option
[WC-LIFE-14]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/lifecycle.md#wc-life-14--a-syncs-status-command-says-how-far-it-is-in-one-shape
[WC-MCP-1]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/mcp.md#wc-mcp-1--a-server-offers-three-tools-not-one-per-command
[WC-MCP-2]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/mcp.md#wc-mcp-2--an-agent-calls-a-command-by-its-cli-path
[WC-MCP-10]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/mcp.md#wc-mcp-10--a-tool-and-its-command-give-the-same-answer-and-the-same-error
[WC-OUT-4]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/output.md#wc-out-4--answer-every-json-request-with-one-envelope-a-list-or-one-thing
[WC-OUT-7]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/output.md#wc-out-7--put-the-facts-about-the-run-in-meta
[WC-OUT-9]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/output.md#wc-out-9--offer-at-most-two-next-steps-and-mark-a-step-safe-only-when-it-changes-nothing-on-the-service
[WC-OUT-10]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/output.md#wc-out-10--answer-a-write-with-what-it-did-and-its-operation_id
[WC-OUT-11]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/output.md#wc-out-11--give-a-shared-command-the-same-answer-shape-in-every-cli-of-its-group
[WC-OUT-12]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/output.md#wc-out-12--use-snake_case-keys-one-meaning-per-key-and-the-registered-identifier-names
[WC-OUT-14]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/output.md#wc-out-14--print-a-failure-in-machine-mode-as-one-json-object-on-stderr-with-stdout-empty
[WC-OUT-18]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/output.md#wc-out-18--exit-with-cli-bases-code-for-each-kind-of-failure
[WC-OUT-19]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/output.md#wc-out-19--report-a-wrong-command-line-as-validation_error-exit-2
[WC-OUT-20]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/output.md#wc-out-20--mark-a-failure-safe-to-retry-only-when-repeating-it-cannot-do-harm
[WC-OUT-21]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/output.md#wc-out-21--keep-only-the-asked-fields-with---jsonab-and-keep-the-envelope
[WC-OUT-22]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/output.md#wc-out-22--fail-visibly-when-machine-output-passes-its-size-cap
[WC-PERM-1]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/permissions.md#wc-perm-1--permissions-is-the-only-access-setting
[WC-PERM-2]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/permissions.md#wc-perm-2--there-are-four-levels-deny-readonly-ask-allow
[WC-PERM-3]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/permissions.md#wc-perm-3--a-key-is-a-command-path-and-the-most-specific-key-wins
[WC-PERM-4]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/permissions.md#wc-perm-4--a-command-that-shows-messages-is-checked-as-messages
[WC-PERM-5]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/permissions.md#wc-perm-5--housekeeping-is-never-gated
[WC-PERM-6]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/permissions.md#wc-perm-6--the-built-in-defaults-ask-only-before-what-cannot-be-undone
[WC-PERM-7]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/permissions.md#wc-perm-7--a-built-in-default-only-ever-tightens
[WC-PERM-11]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/permissions.md#wc-perm-11--some-limits-no-level-lifts
[WC-PERM-13]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/permissions.md#wc-perm-13--every-write-passes-the-write-guard-before-it-leaves
[WC-PERM-18]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/permissions.md#wc-perm-18--a-flood-hold-stops-writes-until-it-ends
[WC-PERM-20]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/permissions.md#wc-perm-20--a-bots-keys-are-the-personal-keys-under-bot
[WC-TOOL-16]: https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/toolchain.md#wc-tool-16--run-the-command-lint-on-the-built-cli-and-let-its-baseline-only-shrink
