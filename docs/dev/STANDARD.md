# The standard for the WireCat CLIs

This page holds the rules for five CLIs: tg (tg-cli), max (max-cli), memo (cli-memo), drive (drive-cli)
and zm (zoom-cli). It says how a command, an option, an answer, an error and an MCP tool are named and
shaped, where code lives, and which documents each has. A CLI's `CONVENTIONS.md` links it instead of
keeping a copy.

- **Every rule binds all five**, unless it names tg and max. Each CLI starts from its own baseline:
  its violations of the [lint rules](#vocabulary-and-lint-rules) are listed in its `lint/baseline/`,
  and that list only shrinks.
- **tg and max only:** tg-cli and max-cli are one tool with two messengers behind it. The
  [parity manifest](#the-parity-manifest), the [option catalogue](#option-catalogue), `bot`, and every
  rule that asks for the same sentence or shape "in both tools" bind those two.

How a pull request is checked against these rules is [REVIEW.md](REVIEW.md).

A rule changes here first, in its own pull request, and the owner approves new wording — a new verb
or option name especially. Then the code follows. A word — a verb, a resource, a view, a root word, a
flag — or a lint rule is added to cli-base's registries (`@wirecat/cli-base/standards`) first; its table
here is regenerated from them with `pnpm standard:docs`, and `pnpm docs:check` fails when the two differ.
A difference between tg and max is allowed only where one messenger lacks the feature, and it is
written down with its reason in the parity manifest.

## External references and our adoption profile

We use external conventions as a baseline, with explicit project decisions below. This is not a
claim of complete POSIX, GNU or agent-spec conformance. The [CLI compliance audit](CLI-COMPLIANCE.md)
records implemented behaviour, gaps and follow-up work; the [architecture](ARCHITECTURE.md#cli-design-references)
explains where these contracts are enforced.

| Reference | Role here |
|---|---|
| [POSIX Utility Conventions, §12](https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap12.html) | Established utility syntax, including the end-of-options delimiter. This is the formal standards reference; our modern long options and nested tree are a project profile, not strict POSIX utility conformance. |
| [GNU Command-Line Interfaces](https://www.gnu.org/prep/standards/html_node/Command_002dLine-Interfaces) | Conventional long-option names, help and version behaviour. We do not copy GNU-specific branding or licensing text. |
| [Command Line Interface Guidelines](https://clig.dev/) | Practical design baseline for command discovery, streams, scripting and compatibility. A guide, not a certification scheme. |
| [MCP tools specification, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | The protocol contract for the MCP adapter; it does not define our shell grammar. Structured tool results and annotations are relevant; outputSchema is optional. |
| [JSON Schema specification](https://json-schema.org/specification) | The schema language for machine contracts. A future CLI schema surface must declare its dialect; a TypeScript interface alone is not runtime schema discovery. |
| [Agent Skills specification](https://agentskills.io/specification) | The portable SKILL.md packaging format and progressive loading of agent guidance. It does not prescribe CLI commands. |
| [Anthropic: writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) | Engineering guidance for distinct tool purposes, informative results and economical discovery. Evaluate these choices against representative tasks. |
| [CLI Agent Spec](https://cli-agent-spec.github.io/) | Independent community requirements and conformance ideas to assess selectively. We do not adopt its exit-code table or response envelope wholesale, or claim a conformance level. |
| [Google Workspace CLI agent context](https://github.com/googleworkspace/cli/blob/main/CONTEXT.md) | A concrete example of schema discovery, response projection and request previews. This is a project example, not a standard or an officially supported Google product. |

[Agent Client Protocol](https://agentclientprotocol.com/get-started/introduction) addresses
editor-to-coding-agent communication. MAX/TG are tools an agent invokes, not coding-agent
implementations, so ACP does not add a compliance requirement to our CLI.

Our additional contract is **agent determinism before presentation convenience**: machine results
are stable data; actions are explicit; uncertain write outcomes are not instructions to retry.
Names, messages and retrieved documents remain untrusted data. Local guards enforce permissions;
MCP hints and agent instructions never substitute for enforcement.

Explicit choices and gaps:

- `stats` and its resource hierarchy are our policy; external references do not require that root.
- Data goes to stdout; failures go to stderr as `{ error: { code, message, ... } }`. We retain
  command-specific success shapes and our exit codes. Parser errors and explicit JSON with a TTY
  currently have gaps documented in the audit; the desired contract does not prove implementation.
- Explicit help/version requests retain conventional text on stdout. An agent discovering a
  command uses `commands <path> --json`; help is not a JSON data response. The independent agent
  spec's blanket non-TTY help-to-stderr rule is not adopted.
- Machine output suppresses write-confirmation prompts, but credentials and setup need a broader
  non-interactive contract. `--yes` grants confirmation; it is not a substitute for disabling input.
- A read can have documented local effects such as ingestion, a stable device identity or a failed-run
  record. Validation-before-remote-action does not promise zero local writes on every error.
- General stdout-only envelopes, automatic retry of all writes, logging full tool payloads and
  new output fields on every existing response are not adopted from agent examples.
- [Command names](#command-names) currently require immediate removal of renamed paths and no
  aliases. This differs from CLIG's deprecation guidance. The owner explicitly chose immediate
  relocation without a compatibility window. Old paths stop working at adoption; the release
  notes and user docs give the new paths.

New commands are reviewed against this profile and the audit. Existing gaps require explicit
implementation work with tests; citing a reference alone does not close them.

## Command names

A name a person reads once should say what the command does; a name an agent reads should be
guessable from the others.

1. **`<tool> [profile] [namespace] <resource> [subresource ...] <verb-or-view> [arguments]`.**
   A namespace groups one cross-resource purpose; `stats` groups statistics. Subresources are
   allowed when they identify a part of the resource (`chats members list`), not an implementation
   detail. A group without a leaf command shows help, never runs a hidden default action.
   **The profile is chosen, never assumed.** A command that acts for one of several accounts or
   profiles takes it explicitly (the first word, the tool's profile variable, or `default_profile` in
   its config file); none given is an error that lists the profiles — never the first in the config,
   never an implicit `default`, not even the only profile; with none the error says how to create one
   by name (`tg personal setup`). A command that touches no account (`account list`, `config show`)
   runs without one. A read across accounts covers all of them and says so.
   The resource is a noun from the [resource table](#resources): **plural** for a collection,
   **singular** for what a profile has exactly one of. A group is never named with a verb. `tags` and `searches` are the owner's own records in the local store, never
   sent; their writes have their own keys (`tags.add`), so a read-only profile hides them.
   `tasks` are what waits on the owner — a question nobody answered, a mention, a request, a promise —
   kept in the local store by `src/tasks/` and never sent: `tasks list|add|close|stats`, the
   type of a task is `--type` (`question`, `request`, `mention`, `promise`), and closing is
   `tasks close <task> --as done|dismissed [--reason <text>]`. The owner chose these on 2026-10-06.
   `attachments` are the files of stored messages: their text, read or written back, is kept in the
   local store for `content:` in a search and never sent; `attachments.extract` is a local write.
   `chats tracking` is the one collection named by what it does rather than a plural: the chats whose
   member lists `serve` fetches daily into the local store — owner's wording, 2026-10-05.
   `chats documents` (planned) are the Google Docs and Drive documents people linked in a chat's stored
   messages: a part of the chat, as its members are, so a subresource of `chats` and not a new root.
   `chats documents list <chat>` reads the local store only, and says per link whether the document
   is in the store. It does not overlap `chats media`, which reads every link from the messenger's
   server and knows no document, or `attachments list`, which lists files, not links in text.
   drive's `sync` writes the message → document link. Owner's name and design, 2026-10-13
   ([plan](chat-documents-plan.md)).
2. **Top-level words** only for what spans every chat or is the tool itself: the
   [root words](#root-words). Prefer an
   existing resource or namespace before adding another root word. A new root needs a reason in
   its naming pull request: what existing group cannot express, which related commands it groups,
   and why the same hierarchy works for both CLIs. One new report never justifies its own root.
3. **Verbs come from the [verb table](#verbs), each with one meaning.** A verb not on it is added
   to cli-base's vocabulary first. Where two verbs are close, the difference:
   - `info` facts about a singular thing itself (`store info`) · `status` how a thing stands right
     now — a running process (`server status`) or what the store holds per chat (`store status`)
   - `check` verify and change nothing; the answer says what is wrong and how to fix it
     (`store check`) · `test` run rules over what is already stored and say what they would have
     done (`replies test`)
   - `sync` bring the local store up to date from the source — only what changed since the last
     run, or the whole list where the source cannot say what changed; `--all` for every chat or
     source (owner, 2026-10-12). It is the regular, repeatable catch-up (`contacts sync`).
     · `fetch` one bounded pull of one named thing into the store, not a catch-up
     (`chats members fetch`)
   - `repair` keeps a table of the wrong shape as a copy (`store repair`, its copies in `store copies`)
   - `link` / `unlink` record a decision someone made, never one inferred from a name (`contacts link`)
   - A **noun as the last word** names a view and shows it, from the [view table](#views):
     `server logs`, `chats events`, `messages scheduled`, `mcp config`, `stats messages top`,
     `stats chats official`.
   - Every word for a command, a resource and a JSON key, with the words it replaces and where a CLI
     still uses another, is in the [glossary](GLOSSARY.md).
4. **One action or report, one leaf command.** A different action or independently useful report
   belongs in a nested command. Options choose the scope, measure, order or format of that action;
   they do not switch a search, send or list into another report. For example, ranking is
   `stats messages top`, not a ranking mode added to `search messages`. Views, reactions and
   replies are measures of the same ranking, so they stay options, not sibling commands.
   No command both shows and changes, except an explicitly documented preparatory fetch such as
   `--sync-first`, which retains its own permissions and reports its outcome.
   **No two commands overlap** (owner, 2026-10-08). If one command's results are a subset of
   another's, one of them goes: an agent that learns the narrow path never finds the wide one. A
   narrower scope is an option or a resource of the same command, never a sibling elsewhere in the tree.
5. **Options are plain words, never a wire field** (`--operation-id`, not `--cid`). One meaning, one
   name, in every command of both tools. **A length of time is a `<duration>`** (`500ms`,
   `30s`, `2m`, `4h`, `1d`) — a number and a unit, never a bare number — parsed as `--timeout`
   is; `--since-time` takes a duration or a time.
   - **The kind of value is in the name** of every option that takes a time, and of one that marks
     a place in a history or a count around it: `-id` a message id, `-time` an ISO 8601 time or a
     duration from now or ago, `-n` a count — `--before-id`, `--after-time`, `--since-time`,
     `--at-time`, `--before-n`. Two kinds, two options, never one
     option that guesses which it was given.
   - **How much, in a list or a fetch:** `--limit <n>` how many items, `--page <n>` which page,
     `--page-size <n>` how many one request to the messenger asks for. A count of pages is never an
     option: it means a different amount in each messenger.
   - The flags with one meaning in every CLI are in the [flag table](#flags); every option tg and
     max have is in the [option catalogue](#option-catalogue).
6. **Arguments have fixed names:** `<chat>`, `<message>`, `<person>`, `<text>`, `<link>`,
   `<file>`, `<job>`, `<task>`.
7. **One word per idea** in help, docs and errors. The **local store** is the message database
   both tools share; max's per-profile **cache** is a different thing until it is replaced, and
   keeps its name until then. `session` is this tool's login; `account sessions` are the other
   devices. **`flood`** is what the messenger told this profile to hold off on — the waits it asked
   for and a hold on writes — kept on this machine; `flood clear` is the owner's and has no MCP tool. The
   **pace** is how fast one profile may ask its messenger, counted across every process (`requests_per_minute`).
8. **An MCP tool is named after its command** — see [MCP](#mcp).
9. **No aliases.** A renamed command's old name stops working, and the release notes say so under
   "may break scripts".

10. **`bot` is the profile's bot account**, through the messenger's official Bot API and a bot
    token — never the personal login. Below it, a command the personal account also has takes the
    same name, arguments and options: `bot messages send`, `bot messages show <chat> <message>`,
    `bot chats members remove`, `bot chats moderate`, `bot contacts show`, `bot watch`. What only a
    bot has: `bot auth`, `bot list`, `bot callbacks`, `bot commands` (the menu people see on `/`),
    `bot webhooks`, `bot uploads`, `bot api`. A bot's send is never repeated — neither Bot API makes
    a repeat safe — so `bot messages send` has no `--operation-id`. A bot command may add an option only a
    bot has, as `bot watch --types` does.

`bot api` is exempt: its names mirror each messenger's official Bot API operations.

### Vocabulary and lint rules

The tables below are generated from `@wirecat/cli-base/standards` by `pnpm standard:docs`; edit the
registry, not the table. "Not" lists the words a term replaces.

`cli-dev lint` checks a CLI's `commands --json` against these rules in each CLI's release check. Every
severity fails the run; severity only orders the report. A violation that is not fixed yet is listed in
that repository's `lint/baseline/<rule>.json`, which only shrinks. A permanent exception goes into
`lint/overrides.json` with its rule, target and reason, at most 10 per repository. Generated commands
(`bot api`) are exempt from the naming and length rules, not from the help rules.

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
| `rename` | change a thing's name only |  |
| `start` | start a running process, or a login session |  |
| `stop` | stop a running process |  |
| `restart` | stop and start a running process |  |
| `end` | end a login session |  |
| `install` | install a system unit |  |
| `uninstall` | remove a system unit |  |
| `cancel` | stop a job or a pending thing |  |
| `sync` | bring the local store up to date from the source: only what changed, or the whole list where the source cannot say | `refresh` |
| `fetch` | one bounded pull of one named thing into the store, not a catch-up |  |
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
| `inspect` | look at a link without joining it |  |
| `send` | send a message |  |
| `edit` | change a sent message |  |
| `forward` | send an existing message on to another chat |  |
| `pin` | pin a message or chat |  |
| `unpin` | unpin a message or chat |  |
| `vote` | answer a poll |  |
| `close` | close a thing that stays: a poll, a task |  |
| `join` | join a chat |  |
| `leave` | leave a chat |  |
| `block` | block a person |  |
| `unblock` | unblock a person |  |
| `mark-read` | mark a chat read; the other person sees it |  |
| `reset` | replace a thing; the old one stops working |  |
| `moderate` | apply a chat's rules: delete what breaks them, act on who broke them |  |
| `confirm` | the owner accepts what an agent proposed | `accept`, `approve` |
| `reject` | the owner refuses what an agent proposed | `decline`, `deny` |
| `move` | move a file in the source |  |
| `copy` | copy a file in the source |  |
| `run` | run a saved job once, now, as its timer would |  |
| `claim` | take a thing for a while so no other agent works it at once; the claim lapses by itself |  |
| `release` | give back what claim took, before it lapses |  |
| `merge` | fold a duplicate into the thing that stays; nothing is deleted |  |
| `unmerge` | undo a merge |  |
| `defer` | leave a decision undecided, for the owner |  |
| `embed` | compute the vectors a meaning search reads, for what is stored and has none |  |

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
| `categories` | the categories a thing takes, with what each means |
| `domains` | the internet domains links point to, most linked first |

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
| `attachments` | collection | files of stored messages |  |
| `tasks` | collection | what waits on the owner |  |
| `members` | collection | people in a chat |  |
| `admins` | collection | administrators of a chat |  |
| `tracking` | collection | the chats whose member lists are fetched daily |  |
| `documents` | collection | files imported from Google Drive or Docs, or linked in a chat |  |
| `notes` | collection | text the owner writes, or files from a notes folder |  |
| `projects` | collection | the owner's work units with a task key |  |
| `organizations` | collection | companies, teams, families or communities |  |
| `identities` | collection | ways to reach a person or an organization: an account in one messenger or mailbox, an e-mail address, a phone |  |
| `facts` | collection | what happened, with evidence |  |
| `memories` | collection | what an agent concluded, with evidence and scope |  |
| `relationships` | collection | confirmed or suggested links between people, organizations and projects |  |
| `files` | collection | files in the source, such as Google Drive, read and changed there |  |
| `comments` | collection | comments people left on a thing in the source: a channel post or a file |  |
| `meetings` | collection | stored meetings, from Zoom or another provider |  |
| `recordings` | collection | the files a provider recorded of a meeting |  |
| `jobs` | collection | work this tool runs in the background or on a timer |  |
| `actions` | collection | what an agent proposes to do; the owner confirms or rejects each |  |
| `aliases` | collection | other names of one thing |  |
| `mentions` | collection | phones, e-mail addresses, links and documents found in stored text, each where it was written |  |
| `images` | collection | pictures in stored messages, searched by what they show |  |
| `duplicates` | collection | pairs of things that may be one, each waiting for a decision |  |
| `session` | singular | this tool's login |  |
| `account` | singular | the messenger or mail account behind a profile |  |
| `config` | singular | a profile's settings |  |
| `server` | singular | the long-running process of a profile |  |
| `store` | singular | the local SQLite database the tools share |  |
| `catalog` | singular | stored source file and folder metadata and parent relationships |  |
| `skill` | singular | the agent skill file of this tool |  |
| `cache` | singular | max's per-profile cache |  |
| `flood` | singular | what the messenger told this profile to hold off on |  |
| `vocabulary` | singular | the owner's catalogue of canonical names, with their aliases |  |
| `api` | singular | the source's own API, one command per operation |  |

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
| `doctor` | check this machine's setup |
| `upgrade` | install a newer version of this tool |
| `commands` | the command tree as data |
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
| `--qr-file` | `<png>` | path | write the login QR code to this PNG instead of drawing it |  |
| `--all-versions` |  | switch | also the earlier versions a newer one replaced |  |
| `--measure` | `<name>` | choice | the metric a ranking is ordered by |  |
| `--newest` |  | switch | newest first instead of best first |  |
| `--order` | `<recent\|name>` | choice | the order of a list: most recent first, or by name |  |
| `--score` | `<preset>` | choice | the named ranking score preset |  |
| `--weights` | `<json>` | string | the ranking component weights, all of them |  |
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
| `--md` |  | switch | the text is the messenger's Markdown |  |
| `--no-backup` |  | switch | do not back the file up before deleting it |  |
| `--no-input` |  | switch | never prompt or open an interactive login |  |
| `--no-preview` |  | switch | no preview card for a link in the text |  |
| `--no-record` |  | switch | do not keep this run, whatever the configuration says |  |
| `--no-registries` |  | switch | do not ask the public ban lists |  |
| `--notify` |  | switch | tell the chat's members about it |  |
| `--offline` |  | switch | answer from what was recorded and never connect |  |
| `--operation-id` | `<id>` | id | the write attempt this repeats, from an unknown outcome; a retry with it cannot write twice |  |
| `--port` | `<port>` | number | the local port for --http |  |
| `--public-url` | `<url>` | string | the public https address of the tunnel |  |
| `--record` |  | switch | keep this run under runs: ids and timings, never content |  |
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
| `--task` | `<id>` | id | a task, by id |  |
| `--to` | `<chat>` | id | the chat it goes to |  |
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

<!-- flags: end -->

#### Lint rules

<!-- lint rules: generated -->

| Rule | Severity | Applies to | Holds when |
|---|---|---|---|
| `unknown-verb` | high | command | a command's last word is a verb or view noun from the vocabulary; a top-level one may be a root word; under search, a resource or all |
| `unknown-resource` | medium | group | a group is a resource from the vocabulary (plural, or a registered singular) or a root word |
| `flag-two-meanings` | high | flag | a flag takes the same kind of value in every command, and the one the vocabulary gives it |
| `missing-command-help` | high | command | every command has a summary |
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
note's transcript, a word of a file's name, and a file's text. Each hit names the place (`matchedIn`:
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
contain counts (`contacts profile`, `store info`);
that does not make it a statistics command. Its main purpose remains describing the entity.
For bot-account statistics the account namespace comes first: `bot stats <resource> ...`, with
the same meanings wherever the provider supports them; this rule does not add Bot API features.

**Relocations are coordinated changes, not aliases.** Move CLI paths, command discovery/help,
completion, generated docs, skills, MCP names, permission keys and saved-run command metadata
together. Preserve existing output semantics during the move. If a permission or stored record
contains an old path, give it an explicit migration; never broaden permissions or silently reuse
an old key for a different action. The release notes name the old and new paths under “may break
scripts”. Old paths stop working in the release that adopts the new tree. Consumers adopt the
same shared implementation and manifest; a provider-specific difference needs a reason.

### Before creating a command

The naming pull request answers these questions before implementation:

1. What does the user want to do or learn, and which existing resource or namespace owns it?
   If the answer is a statistical report, its path starts with `stats`.
2. Is this a new action/report or a scope/measure/format variant of an existing leaf? Put the
   former in the command tree and the latter in options. Show the proposed parent help so the
   new command can be found without knowing its flags.
3. Are every resource word, leaf verb/view, argument and option consistent with both CLIs?
   A nested path must explain each level. Do not abbreviate or invent another word for an
   existing subject. Check the option catalogue before proposing a new option.
4. What result, coverage and permission contract does the leaf have, and how does its full path
   map to its MCP name? Record planned paths/options in the parity manifest before code.
5. Does it move or replace an existing command? List callers, generated pages, saved records and
   configuration that need migration; describe the breaking change before shipping it.

The owner approves new wording in this naming pull request. The review checklist applies these
questions to every subsequent command addition; they are not specific to rankings.

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


## Agent execution contract

The full audit remediation adds one scoped `commands schema <path...>` view, rather than a new
root or a schema mode on message commands. It describes raw argv inputs, result schemas, effects,
permissions, conditional arguments and safe-retry semantics in JSON Schema 2020-12. Open provider
extensions must be labelled; a structural schema is not evidence of complete business validation.
CLI and MCP use the same domain result definitions where available. MCP structured outputs are
validated against any output schema advertised by the server.

The shared shell adds these conventions; the manifest tracks adoption:

- `--no-input` prohibits prompts and browser login. JSON/JSONL with a TTY also suppresses prompts.
  Non-TTY data piped for an explicit command remains usable. Confirmation flags never lift deny.
- `--max-input-bytes` bounds buffered stdin (16 MiB by default); cancellation releases listeners
  and does not leave an open read waiting for EOF. Secrets have a tighter 64 KiB bound.
- One-shot actions have a 30-second default budget unless a flag/environment supplies another.
  Help/version and intended watch/serve/MCP lifetimes are exempt. Signals cancel tracked resources;
  SIGINT/SIGTERM follow shell exit conventions. Broken pipes end quietly without a stack trace.
- `--json=id,text` keeps only those fields of each item; the envelope (`page`, `next`, `meta`) stays. A bare
  `--json` at a terminal names the fields of a command that declares its answer, instead of printing them all.
  Paths are relative to the payload: `source.title` selects a nested object field, and
  `groups.cues.text` projects every element of nested arrays without changing their order or length.
  `items.ref` is the list-item shorthand, including report lists inside `item`; numeric indexes and
  wildcards are unsupported. Selecting a parent retains that entire subtree. Missing fields are omitted;
  explicitly selected nulls remain null. Projection retains `page`, `next`, `missing`, `meta`, `coverage`
  and `operation_id` at each selected object, so a compact result still describes its limits.
  Typed JSONL item records select from `data`; their `type` marker and the completion record stay.
  All CLIs use Base's projector; Core owns the `--json=<paths>` grammar and translates validation errors.
  `--max-output-bytes` bounds serialized machine data (4 MiB; zero explicitly disables the bound).
  Exceeding a bound fails visibly with `retry.safe: false`, never a malformed or silently cropped JSON
  response. File exports retain their streaming contract.
- A global `--dry-run` validates parsed arguments and permission policy, then reports a preview
  without invoking the action, reading credentials or reserving a write. Local command-specific
  previews keep their richer behaviour. A preview declares unresolved targets and preparatory
  effects; it is never a guarantee that a subsequent write will succeed.
- Every error has `retry: { safe, after_ms? }`, derived from its code, the command's `effects` and whether the
  write left: a transient failure (`timeout`, `rate_limited`, `network_error`, `provider_unavailable`) is safe
  for a command that writes nothing on the messenger, or for a write that never left (`sent: false`).
  `outcome_unknown` never is — repeat that write only with its `--operation-id`. Every command declares
  `effects: { remote, local }` (`none | read | write`) in `commands --json`; one without counts as a write.
- Installed skills are checked against binary discovery. Synthetic task evaluations cover command
  selection, bounded paging, validation recovery and refusing replay after an unknown write outcome.

These defaults are technical execution limits, not profile data or new config-file keys.
User pages explain the effective defaults and how to override them after consumer adoption.

## Option catalogue

Every option of both tools, once: its value, what it means, its default and the commands that take
it. An option means one thing wherever it appears; a new one is added to `parity.json` first, with
its meaning, and this table is regenerated from it. **Bold** marks a clash still to resolve.

<!-- option catalogue: generated by `pnpm parity:render` from parity.json -->

| Option | Value | Meaning | Default | Commands |
|---|---|---|---|---|
| `--accept-terms` |  | accept the model's licence terms, for a model that has its own |  | `models text download` |
| `--add` | `<chat>` | put a chat into a folder; repeat it for more |  | `bot webhooks set` (max-only), `chats folders update` |
| `--after-n` | `<n>` | how many messages after it |  | `messages context` |
| `--agent` | `<agent>` | install the skill for this agent; asks at a terminal, otherwise none |  | `setup` |
| `--ai` |  | call the configured reply model with stored message data; requires reply consent, otherwise uses fallback |  | `replies test` |
| `--all` |  | every row, no paging. **chats requests accept and decline take every pending request instead — Telegram counts them against its hourly limit first; MAX has no way to answer them all at once and refuses it, naming chats requests list — so it differs on purpose (Help text rule 4)** |  | `attachments list`, `chats list`, `chats members list`, `chats requests accept`, `chats requests decline`, `contacts list`, `inbox`, `messages download`, `messages sync`, `review`, `searches history`, `sends list`, `store export`, `store jobs list` |
| `--all-bots` |  | also read every other bot's copy on this machine that read_other_bots allows |  | `bot contacts show`, `bot messages between`, `bot search messages` |
| `--all-can-pin` | `<on\|off>` | every member may pin messages |  | `chats update` |
| `--all-in-chat` |  | decide a name in every undecided place of it in the same chat too |  | `mentions confirm` (planned), `mentions reject` (planned) |
| `--allow-any-file` |  | send a --file even from credential folders or the tool's own folders |  | `bot api` (planned), `bot messages send`, `messages send` |
| `--allow-chats` | `<ids>` | replace allowed chat ids, comma-separated; empty clears |  | `replies audience`, `replies edit` |
| `--allow-dangerous` |  | go ahead without the question an ask level puts before a deletion |  | `bot chats moderate`, `bot messages delete`, `chats clear` (planned), `chats delete` (planned), `chats moderate`, `messages delete`, `store clear` |
| `--allow-people` | `<ids>` | replace allowed sender ids, comma-separated; empty clears |  | `replies audience`, `replies edit` |
| `--allow-writes` |  | acknowledge that the profile offers writing tools when installing local MCP |  | `mcp setup` |
| `--analyze` |  | link conversation batches using the configured analysis provider, with remembered chat/provider consent |  | `conversations build` |
| `--anonymous` |  | nobody sees who voted for what |  | `polls create` |
| `--answerer` | `<person>` | stored name, alias, @username, ID or scoped person locator; ambiguous names require a choice; repeat it for more |  | `stats chats newcomers`, `stats contacts responses`, `stats messages unanswered` |
| `--app` | `<how>` | the first time only: how to get this profile's app from my.telegram.org | `browser` | `session start` (tg-only), `setup` (tg-only) |
| `--approval` |  | who joins by it asks first, and an admin lets them in |  | `chats link create` (tg-only), `chats link update` (tg-only) |
| `--as` | `<state>` | how a task is closed: done, or dismissed — it needs no answer |  | `tasks close` |
| `--as-file` |  | send every --file as a plain file to download, a video included |  | `bot messages send`, `messages send` |
| `--as-owner` |  | record a decision as the owner's although an agent's terminal runs the tool |  | `mentions confirm` (planned), `mentions reject` (planned) |
| `--as-reply` |  | send as a reply to the matched message |  | `replies edit` |
| `--at` | `<HH:MM>` | every day at this local time |  | `schedule agent`, `schedule command` |
| `--at-time` | `<time>` | let the messenger send it later, even with this machine off: a local time like 2026-09-25T09:00, or 30m. **schedule agent and schedule command take it for their one run: a duration from now or an ISO 8601 time** |  | `messages send`, `schedule agent`, `schedule command` |
| `--attachment` | `<n>` | which file of the message, from 1; needed when it has more than one |  | `attachments show`, `attachments text set` |
| `--backend` | `<archive\|server\|both>` | where to search: the local archive, the messenger's server, or both (default: both; message discovery uses archive only) |  | `search all` (planned), `search messages` |
| `--background` |  | run as a job that outlives this command; `store jobs show` follows it |  | `messages sync`, `store gaps repair` |
| `--base-url` | `<url>` | a server with OpenAI's /v1/embeddings: Gemini, Jina, or Ollama and LM Studio on this machine |  | `conversations build`, `conversations embed`, `conversations embed clear`, `conversations embed status`, `conversations related`, `conversations status`, `search conversations` |
| `--batch` | `<id>` | the batch id `conversations batches next` printed |  | `conversations links add` |
| `--before-n` | `<n>` | how many messages before it |  | `messages context` |
| `--block` | `<value>` | Set to `true` if user should be blocked in chat. |  | `bot chats members remove` |
| `--bot` |  | the bot section of the profile's settings, rather than the personal account's |  | `config set`, `config show`, `config unset` |
| `--bots` | `<profiles>` | also read these bots' copies, comma separated — each allowed by read_other_bots |  | `bot contacts show`, `bot messages between`, `bot search messages` |
| `--brief` |  | found messages and mail as reference, title, time, sender and excerpt only |  | every command (planned) |
| `--by` | `<grouping>` | what to count by. **each command names its own groupings — stats messages show chat, sender, day or hour, and searches create the same for stats messages show --saved; stats chats show day or week, as a series beside its totals — so it differs on purpose (Help text rule 4)** |  | `searches create`, `stats charts`, `stats chats retention`, `stats chats show`, `stats messages show` |
| `--calls` | `<who>` | who may call: everyone, contacts or nobody |  | `account privacy set` (planned) |
| `--can` | `<rights>` | what they may do, comma-separated: read, members, admins, info, pin, link, post, edit, delete. **lists the rights each messenger has — MAX has `read`, Telegram does not — so it differs on purpose (Help text rule 4)** |  | `bot chats admins add`, `chats admins add` |
| `--caption-above` |  | show the text above the --photo or --file, not below it |  | `messages send` (tg-only) |
| `--catch-up` |  | prepare local search: after this run, or before a search reads it |  | `messages sync`, `search conversations`, `store gaps repair` |
| `--catch-up-chunks` | `<n>` | at most this many local vector chunks |  | `messages sync`, `store gaps repair` |
| `--catch-up-messages` | `<n>` | skip a graph rebuild above this message budget |  | `messages sync`, `store gaps repair` |
| `--catch-up-time` | `<duration>` | time budget for local preparation |  | `messages sync`, `store gaps repair` |
| `--category` | `<name>` | what a task is about, from the list tasks categories prints |  | `tasks add`, `tasks plan` |
| `--channel` |  | a private channel instead of a group; people join it by its link |  | `chats create` |
| `--chart-kind` | `<messages\|active\|membership>` | what to draw: messages, active authors, or joins and leaves | `messages` | `stats charts` |
| `--chat` | `<chat>` | a chat, by id or name; repeat it for more. **chat addressing follows each messenger's supported names, usernames and Saved Messages aliases, so it differs on purpose (Help text rule 4)** |  | `attachments extract`, `chats folders create`, `contacts context`, `conversations batches next`, `conversations batches status`, `conversations build`, `conversations consents revoke`, `conversations embed`, `conversations embed clear`, `conversations embed status`, `conversations links clear`, `conversations status`, `images embed`, `metadata get`, `metadata refresh`, `search conversations`, `searches create`, `stats contacts responses`, `stats contacts top`, `stats messages counters refresh`, `stats messages counters show`, `stats messages discussion`, `stats messages show`, `stats messages top`, `stats messages unanswered`, `stats tasks show`, `tags add`, `tags auto`, `tags remove`, `tasks link` |
| `--chat-invites` | `<who>` | who may add the account to groups and channels: everyone, contacts or nobody |  | `account privacy set` (planned) |
| `--check` |  | say whether a newer version exists, and install nothing |  | `bot list`, `upgrade` |
| `--checkpoints` | `<durations>` | elapsed joining ages to inspect, such as 1d,7d,30d |  | `stats chats retention` |
| `--chunk-bytes` | `<n>` | maximum source bytes returned from a retained attachment; 1–1048576 | `524288` | `attachments show` |
| `--close-time` | `<delay>` | it closes by itself this long after sending, like 90s or 5m |  | `polls create` (tg-only) |
| `--closed` | `<on\|off>` | on closes a forum topic to new messages, off reopens it |  | `topics edit` (tg-only) |
| `--comment-to` | `<post>` | comment on this channel post; the comment goes to the post's discussion group |  | `messages send` (tg-only) |
| `--component` | `<name>` | the ranking component whose contributing messages or answer pairs to read |  | `stats contacts evidence`, `stats messages evidence` |
| `--concurrency` | `<n>` | remote: requests at once (default: 4) |  | `attachments extract`, `conversations embed` |
| `--contact` | `<person>` | the person to tag or untag: their id, @username or name, as the local store knows them |  | `tags add`, `tags remove` |
| `--contacts-only` |  | match only contacts |  | `replies edit` |
| `--context` | `<n>` | messages before and after each hit |  | `search messages`, `searches create` |
| `--correct` | `<n>` | with --quiz: the right answer's position, from 1 |  | `polls create` (tg-only) |
| `--counters` | `<names>` | the counter fields: views,reactions,comments |  | `stats messages counters refresh`, `stats messages counters show` |
| `--cursor` | `<cursor>` | continue from the extraction or ranking-evidence cursor |  | `attachments extract`, `chats media` (planned), `contacts timeline`, `messages comments` (tg-only), `messages evidence`, `messages list`, `stats contacts evidence`, `stats messages evidence` |
| `--days` | `<days>` | days of the working window, such as mon-fri or sat,sun |  | `replies edit` |
| `--debug` |  | on a failure, its whole record — cause and stack — in place of the short line |  | every command |
| `--deep` | `<n>` | also check the top n in full — profile, photos, everything they wrote, and the public ban lists, which are sent their ids — one person a second. **TG specializes the SDK help with the bounded Telegram audit; MAX retains the generic SDK wording. Align the shared help with provider capabilities separately; SDK adoption alone does not remove the difference.** |  | `chats members audit` |
| `--defaults` |  | change what every profile gets, rather than this profile |  | `config set`, `config unset` |
| `--deny-chats` | `<ids>` | replace denied chat ids, comma-separated; empty clears; deny wins |  | `replies audience`, `replies edit` |
| `--deny-people` | `<ids>` | replace denied sender ids, comma-separated; empty clears; deny wins |  | `replies audience`, `replies edit` |
| `--description` | `<text>` | the new about text — of a chat or of your account. **tasks add and tasks plan use Markdown for task details, completion criteria and next steps** |  | `account update`, `chats update`, `tasks add`, `tasks plan` |
| `--dims` | `<n>` | remote: the vector size — needed with --base-url; shortens an OpenAI model's |  | `conversations embed`, `conversations embed clear`, `conversations embed status`, `conversations related`, `conversations status`, `search conversations` |
| `--discover` |  | find partial lexical matches and eligible replies in the local archive; results are evidence, not confirmed answers |  | `search messages` |
| `--do` | `<actions>` | actions: reply, task, or both, comma-separated |  | `replies edit` |
| `--download` |  | first save, from the messenger, the files no download saved yet |  | `attachments extract` |
| `--dry-run` |  | judge and plan; do nothing. **A command-specific dry run keeps its richer plan; otherwise the shared shell previews arguments and permissions without running the action. Targets remain unresolved unless that command provides a preview.** |  | every command, `bot chats moderate`, `chats moderate`, `messages sync`, `stats messages counters refresh`, `store repair`, `tags auto` |
| `--due` | `<time>` | when a task must be done: an ISO 8601 time or a duration from now; none clears it |  | `tasks add`, `tasks plan` |
| `--due-within` | `<duration>` | list tasks due within this: 30m, 2h, 1d | `1d` | `tasks agenda` |
| `--emoji` | `<emoji>` | the folder's icon |  | `chats folders create` (tg-only), `chats folders update` (tg-only) |
| `--encrypt` |  | compress and encrypt with a password, typed at a hidden prompt or piped on stdin; never kept |  | `store backup`, `store export` |
| `--error-code` | `<code>` | filter diagnostic runs by a stable error code |  | `runs search` |
| `--events` |  | also print edits, deletions and reactions; every line then names its event. **watch updates use this flag independently of the group event --type filter** |  | `bot watch`, `watch` |
| `--every` | `<duration>` | repeat at this interval: 30m, 2h, 1d |  | `schedule agent`, `schedule command` |
| `--exact` |  | bare words and quotes match their exact form only, as exact:word does; text: still matches every form |  | `search all`, `search messages`, `search notes`, `searches create`, `stats contacts responses`, `stats contacts top`, `stats messages counters refresh`, `stats messages counters show`, `stats messages discussion`, `stats messages show`, `stats messages top`, `stats messages unanswered` |
| `--exclude-chat` | `<chat>` | never show this chat in the folder; repeat it for more |  | `chats folders create` (tg-only), `chats folders update` (tg-only) |
| `--expected-fingerprint` | `<hash>` | require the whole retained file to match this previous SHA256 |  | `attachments show` |
| `--expire-time` | `<time>` | it stops working then: 2026-09-25T09:00 (local time), or 30m, 2h, 7d from now |  | `chats link create` (tg-only), `chats link update` (tg-only) |
| `--extract` |  | extract text from files mapped by this download |  | `messages download` |
| `--failed` |  | every chat whose newest job failed or died |  | `store jobs retry` |
| `--file` | `<file>` | attach a file; images go as a photo, videos as a video. Repeat it for more |  | `bot messages send`, `contacts notes add`, `contacts notes edit`, `messages send` |
| `--filename` | `<name>` | the name others see for the --file, instead of its name on disk |  | `messages send` (tg-only) |
| `--filter` | `query` | Strict Lucene filter: any message in the conversation must match; the meaning query stays unchanged. **search notes uses it for a query every note must also match, the meaning half unchanged** |  | `search conversations`, `search notes` |
| `--find-by-phone` | `<who>` | who finds the account by its number: everyone, contacts or nobody |  | `account privacy set` (planned) |
| `--fingerprint` | `<hash>` | refuse if the inspected coverage plan changed |  | `store gaps repair` |
| `--first-name` | `<name>` | your first name |  | `account update` |
| `--for` | `<agents>` | which agents a skill is installed for: claude, agents or all | `all` | `skill install` |
| `--for-everyone` |  | delete for everyone in the chat, not only for you — they cannot get it back |  | `messages delete` |
| `--format` | `<format>` | jsonl, one message per line, or a markdown transcript. **the shared `store export` takes `jsonl` or `markdown`, max's own takes `jsonl` or `md` (e4)** |  | `store export` |
| `--from` | `<who>` | sender to match in `bot search messages` |  | `bot search messages` |
| `--from-dir` | `<dir>` | read nonrecursive files from this directory for one explicit chat |  | `attachments extract` |
| `--full` |  | found messages and mail with their whole text and every provider field |  | every command (planned) |
| `--hidden` | `<on\|off>` | on hides a forum's General topic from the topic list, off shows it |  | `topics edit` (tg-only) |
| `--hide-online` | `<on\|off>` | hide online status and last seen |  | `account privacy set` (planned) |
| `--history` |  | the people added also see the messages from before they came |  | `chats members add` (max-only) |
| `--holder` | `<name>` | who you are for task claims: a session or chat id |  | `tasks agenda`, `tasks claim`, `tasks release` |
| `--html` |  | the text is HTML: <b>, <i>, <a href>, <code> |  | `bot messages edit`, `bot messages send`, `messages edit` (tg-only), `messages send` (tg-only) |
| `--http` |  | serve MCP over HTTP on 127.0.0.1 behind the owner's tunnel, with a one-owner login. **MAX spells out that profile permissions decide; Telegram wording catches up at its next shared SDK adoption** |  | `mcp` |
| `--idle` | `<duration>` | stop after this long with nobody using it — 15m, 1h |  | `serve` (max-only), `server restart` (max-only), `server start` (max-only) |
| `--include` | `<kinds>` | every chat of these kinds, comma-separated. **a folder (`chats folders`) or an export folder (`store export`) takes these chats** |  | `chats folders create` (tg-only), `chats folders update` (tg-only), `store export` |
| `--into` | `<id>` | the task that stays: a duplicate is merged into it, or a message is linked to it instead of opening a task |  | `tasks add`, `tasks merge` |
| `--join-approval` | `<on\|off>` | people ask to join, and an admin lets them in |  | `chats update` (tg-only) |
| `--json` |  | machine-readable output: one JSON value on stdout, nothing else |  | every command |
| `--jsonl` |  | machine-readable output: one JSON object per line, for streaming and jq |  | every command |
| `--kind` | `<kind>` | only chats of this kind: dialog, group, channel or saved |  | `inbox`, `review`, `tasks link` |
| `--kinds` | `<kinds>` | chat kinds: dialog, group; comma-separated, empty for any |  | `replies edit` |
| `--last` | `<n>` | stop once the newest n messages are held; not with --since. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `bot store fetch`, `messages sync` |
| `--last-name` | `<name>` | your last name |  | `account update` |
| `--lease` | `<duration>` | how long a task claim lasts, such as 30m or 2h; claiming again extends it | `30m` | `tasks claim` |
| `--left` |  | only the chats this account has left |  | `store clear` |
| `--limit` | `<n>` | how many: rows to show, or messages one run fetches. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `attachments extract`, `attachments list`, `bot chats members list` (max-only), `bot contacts show`, `bot messages between`, `bot messages list`, `bot search messages`, `bot store fetch`, `calls list` (planned), `chats documents list` (planned), `chats link list` (tg-only), `chats list`, `chats media` (planned), `chats members list`, `chats requests list`, `contacts context`, `contacts list`, `contacts timeline`, `conversations list`, `conversations related`, `images embed`, `inbox`, `mentions domains` (planned), `mentions list` (planned), `messages comments` (tg-only), `messages evidence`, `messages list`, `messages sync`, `metadata refresh`, `polls voters` (tg-only), `runs list`, `runs search`, `search all`, `search conversations`, `search messages`, `search notes`, `searches create`, `searches history`, `sends list`, `server logs`, `stats chats newcomers`, `stats chats retention`, `stats contacts evidence`, `stats contacts responses`, `stats contacts top`, `stats messages counters refresh`, `stats messages counters show`, `stats messages discussion`, `stats messages evidence`, `stats messages show`, `stats messages top`, `stats messages unanswered`, `store gaps repair`, `store jobs list`, `tags auto`, `tasks duplicates`, `tasks list`, `tasks related` |
| `--link` | `<link>` | an invite link: only the requests made through it. **accept and decline take it with --all — one link, worded for each command (Help text rule 4)** |  | `chats requests accept`, `chats requests decline` |
| `--local` |  | use the model on this machine, never the messenger |  | `messages transcribe` (tg-only) |
| `--mark-read` |  | also mark the chat read up to the newest message shown; the other person sees it |  | `inbox`, `messages list`, `review` |
| `--marker` | `<value>` | Marker |  | `bot chats members list` (max-only) |
| `--max-actions` | `<n>` | at most this many actions in one run | `10` | `bot chats moderate`, `chats moderate` |
| `--max-age` | `<duration>` | the observation-age threshold for a fresh counter snapshot |  | `stats messages counters show` |
| `--max-chats` | `<n>` | at most this many chats in one run. **local graph work defaults to 20; opt-in --sync-first network refresh defaults to 5, so help distinguishes the two uses** | `20` | `conversations build`, `conversations embed`, `search conversations`, `search messages`, `stats contacts top`, `stats messages show`, `stats messages top` |
| `--max-chunks` | `<n>` | at most this many chunks embedded in one run | `2000` | `conversations embed`, `search conversations` |
| `--max-cost` | `<usd>` | stop an agent's run that costs more than this, in US dollars |  | `schedule agent` |
| `--max-gaps` | `<n>` | maximum interior coverage gaps repaired in this run |  | `store gaps repair` |
| `--max-input-bytes` | `<bytes>` | at most this many bytes of buffered stdin | `16777216` | every command |
| `--max-meetings` | `<n>` | how many of the meeting account's meetings to look through, newest first, or all for every one (default 100) |  | `search all` (planned) |
| `--max-messages` | `<n>` | fetch at most this many messages total (default: 500) |  | `search conversations`, `search messages`, `stats contacts top`, `stats messages counters refresh`, `stats messages show`, `stats messages top` |
| `--max-output-bytes` | `<bytes>` | at most this many serialized bytes of machine data; 0 disables the bound | `4194304` | every command |
| `--max-pages` | `<pages>` | at most this many pages of a list, with a pause between them |  | `chats members audit`, `chats members fetch` |
| `--max-replies` | `<n>` | maximum observed discussion replies |  | `stats messages discussion` |
| `--max-subscriber-buffer-bytes` | `<bytes>` | buffer per watcher before disconnecting it; 0 is unlimited |  | `serve` (max-only) |
| `--max-subscriber-total-buffer-bytes` | `<bytes>` | combined watcher buffer budget; 0 is unlimited |  | `serve` (max-only) |
| `--max-tokens` | `<n>` | remote embeddings: bound input tokens; analysis: reserve input and output tokens across this run |  | `conversations build`, `conversations embed` |
| `--max-uses` | `<n>` | at most this many people join by it, 1 to 99999 |  | `chats link create` (tg-only), `chats link update` (tg-only) |
| `--md` |  | read this messenger's Markdown; see its formatting guide for supported syntax |  | `bot messages edit`, `bot messages send`, `messages edit`, `messages send` |
| `--measure` | `<name>` | the metric used to order a ranking; not with --score or --weights |  | `stats contacts top`, `stats messages top` |
| `--members-see-link` | `<on\|off>` | members may see the invite link |  | `chats update` (max-only) |
| `--mentions-me` |  | require a mention of you or a reply to you |  | `replies edit` |
| `--message` | `<message>` | the message to tag or untag: its id in --chat, or a msg: locator alone |  | `tags add`, `tags remove` |
| `--message-kind` | `<all\|posts\|comments>` | the proven kind of messages selected before ranking | `all` | `stats contacts top`, `stats messages top` |
| `--method` | `<method>` | how to log in when there is no session |  | `setup` |
| `--min-messages` | `<n>` | minimum selected messages for a ranked author | `1; 5 for engaging unless explicitly set` | `stats contacts top` |
| `--min-views` | `<n>` | minimum known cumulative views |  | `stats messages discussion` |
| `--model` | `<id>` | which downloaded speech model hears them; `models audio list` shows them. **max's own copy is worded differently until T6 moves the command onto the shared one (e13); replies edit uses this option for legacy template mode: fill-only or may-reword; use ai blocks instead** |  | `conversations build`, `conversations embed`, `conversations embed clear`, `conversations embed status`, `conversations links clear`, `conversations related`, `conversations status`, `inbox`, `messages list`, `messages transcribe`, `replies edit`, `review`, `search conversations` |
| `--multiple` |  | people may pick several answers |  | `polls create` |
| `--new` |  | what arrived since the last check, each message once — for scheduled runs. **tasks add instead opens the task although tasks that may be the same job were listed** |  | `inbox`, `mentions list` (planned), `review`, `tasks add` |
| `--newest` |  | newest first instead of best first |  | `bot search messages`, `search messages`, `searches create` |
| `--no-approval` |  | anyone with it joins at once |  | `chats link update` (tg-only) |
| `--no-as-reply` |  | send without linking to the matched message |  | `replies edit` |
| `--no-backup` |  | delete the store without backing it up first |  | `store reset` |
| `--no-block` |  | remove without banning; by default a removed person cannot come back by the link |  | `bot chats moderate` |
| `--no-catch-up` |  | skip local preparation after this run |  | `messages sync`, `store gaps repair` |
| `--no-contacts-only` |  | do not require a contact |  | `replies edit` |
| `--no-hours` |  | clear the working window |  | `replies edit` |
| `--no-input` |  | never prompt or open an interactive login; piped input remains available |  | every command |
| `--no-mark-read` |  | do not mark read, whatever the catch_up_marks_read setting says |  | `inbox`, `review` |
| `--no-mentions-me` |  | do not require a mention of you or a reply to you |  | `replies edit` |
| `--no-preview` |  | no preview card for a link in the text |  | `messages send` |
| `--no-question` |  | do not require a question |  | `replies edit` |
| `--no-record` |  | do not keep it, whatever the configuration says |  | every command |
| `--no-registries` |  | do not ask the public ban lists; nothing about them leaves this machine. **TG clarifies that profile and photo reads still use Telegram when public registries are disabled; MAX retains the generic SDK wording. Public registry queries apply to Telegram only.** |  | `contacts check` |
| `--no-serve` |  | do not start it; log in on this command's own connection unless one is running |  | every command (planned) |
| `--notification` | `<text>` | a note only the person who pressed sees |  | `bot callbacks answer` |
| `--notify` |  | tell the chat's members about the pin |  | `bot messages pin`, `messages pin` |
| `--ocr` |  | explicitly call models.ocr for bulk image and scanned-PDF text extraction; agents normally transcribe files themselves |  | `attachments extract` |
| `--offline` |  | answer from what was recorded and never connect; fails if nothing was |  | every command |
| `--offset-bytes` | `<n>` | start byte offset in a retained attachment | `0` | `attachments show` |
| `--older-than` | `<duration>` | minimum age of a question without an observed qualifying answer |  | `stats messages unanswered` |
| `--online` |  | also log in once, read one chat and start the MCP server; sends nothing. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `doctor` |
| `--only` | `<resources>` | only these resources, separated by commas: messages, notes; meetings when --source names a meeting account |  | `search all` |
| `--only-admins-add` | `<on\|off>` | only admins may add members |  | `chats update` |
| `--only-admins-call` | `<on\|off>` | only admins may start a call |  | `chats update` (max-only) |
| `--only-missing` |  | only chats with no metadata yet; without --chat, every stored group/channel |  | `metadata refresh` |
| `--only-owner-edits-info` | `<on\|off>` | only the owner may change the name and photo |  | `chats update` (max-only) |
| `--operation` | `<name>` | filter diagnostic events by operation |  | `runs search` |
| `--operation-id` | `<id>` | identify a send or creation attempt; message/poll retries reuse it, while an unknown topic creation must never be repeated |  | `messages forward`, `messages send`, `polls create`, `topics create` (tg-only) |
| `--order` | `<recent\|name>` | newest conversation first, or alphabetical |  | `contacts list` |
| `--others` |  | every session but this one. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `account sessions end` |
| `--output` |  | where to write: a directory for `messages download`, a file for `store export`. **`store export` and other commands use --output for a file; `messages download` takes --output-dir — e10** | `.` | `doctor report create`, `stats charts`, `store decrypt`, `store export` |
| `--output-dir` | `<dir>` | the folder to write into, created if missing. **`attachments extract` takes it only with --download, and has no default there, so extraction never fills the working folder unasked** | `.` | `attachments extract`, `messages download`, `store export` |
| `--outside` | `<hours>` | answer outside this 24-hour window, such as 09:00-19:00 |  | `replies edit` |
| `--page` | `<n>` | which page, starting at 1 |  | `attachments list`, `attachments show`, `bot search messages`, `chats documents list` (planned), `chats list`, `chats members list`, `chats requests list`, `contacts list`, `mentions domains` (planned), `mentions list` (planned), `runs list`, `runs search`, `search all`, `search messages`, `search notes`, `searches history`, `sends list`, `store jobs list` |
| `--page-size` | `<n>` | how many items one request to the messenger asks for; the messenger's own if not given. **the default is each messenger's own page: 30 on MAX, 100 on Telegram** |  | `bot store fetch`, `messages sync`, `store gaps repair` |
| `--pause` | `<duration>` | the least wait between pages, 5s or 500ms; each is up to twice that. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** | `5s` | `bot store fetch`, `messages download`, `messages sync`, `store gaps repair` |
| `--per-chat` | `<limit>` | at most this many per chat, such as 1/12h |  | `replies edit` |
| `--per-person` | `<limit>` | at most this many per person, such as 1/1d |  | `replies edit` |
| `--permission` | `<key=level>` | override a permission for this MCP server only; repeat for more keys |  | `mcp`, `mcp config`, `mcp doctor`, `mcp setup` |
| `--personal` |  | the personal account's section of the profile's settings |  | `config set`, `config unset` |
| `--phone-number` | `<who>` | who sees the number: everyone, contacts or nobody |  | `account privacy set` (planned) |
| `--photo` | `<file>` | an image file — a profile photo in `account update`, a group's photo in `chats update`, a photo to send in `messages send` |  | `account update`, `bot messages send`, `chats update` (planned), `messages send` |
| `--pin` | `<chat>` | pin this chat at the top of the folder; repeat it for more |  | `chats folders create` (tg-only), `chats folders update` (tg-only) |
| `--pinned` | `<on\|off>` | on pins a forum topic at the top of the list, off unpins it |  | `topics edit` (tg-only) |
| `--port` | `<port>` | the local port for --http |  | `mcp` |
| `--problems` |  | only failed responses, warnings and crashes |  | `runs show` |
| `--profile` | `<name>` | filter diagnostic runs by recorded profile |  | `runs search` |
| `--provider` | `<provider>` | embedding provider: local or openai; analysis: agent, openai or anthropic; consents revoke: exact provider identity from the list |  | `conversations build`, `conversations consents revoke`, `conversations embed`, `conversations embed clear`, `conversations embed status`, `conversations related`, `conversations status`, `search conversations` |
| `--public-url` | `<url>` | the tunnel's https address the browser apps use |  | `mcp` |
| `--qr-file` | `<png>` | write the QR code to this PNG instead of drawing it, for an agent to pass on |  | `session start` (tg-only), `setup` (tg-only) |
| `--question` |  | match only questions |  | `replies edit` |
| `--quiet` |  | diagnostics off. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | every command |
| `--quiz` |  | a quiz: one answer is right, and a vote is final |  | `polls create` (tg-only) |
| `--reason` | `<text>` | why a task was closed, kept with it — no-reply-needed, for example |  | `tasks close` |
| `--record` |  | keep this run under `runs` — ids and timings, never message content. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | every command |
| `--remind-time` | `<time>` | when to look at it again: an ISO 8601 time or a duration from now; none clears it |  | `tasks add`, `tasks plan` |
| `--remove` | `<chat>` | take a chat out of a folder; repeat it for more |  | `chats folders update` |
| `--repair-time` | `<duration>` | time budget for interior archive gap repair |  | `store gaps repair` |
| `--replace` |  | overwrite a saved search of the same name |  | `searches create` |
| `--reply` | `<mode>` | answer all or only listed senders and chats: all, listed |  | `replies audience` |
| `--reply-to` | `<message>` | answer this message id in the same chat |  | `bot messages send`, `messages send` |
| `--retract` |  | take your vote back, where the poll allows it |  | `polls vote` |
| `--revision` | `<n>` | the revision you read before editing |  | `contacts notes edit` |
| `--revoke` |  | forget every login given to a browser app over --http |  | `mcp` |
| `--revote` |  | people may change their vote |  | `polls create` |
| `--run` | `<id>` | the run the report is about; the newest failed one if not given |  | `doctor report create` |
| `--saved` | `<name\|id>` | run a saved search, or an earlier run by its id; options typed with it replace its own, more words are AND-ed |  | `search messages`, `stats chats newcomers`, `stats contacts responses`, `stats contacts top`, `stats messages discussion`, `stats messages show`, `stats messages top`, `stats messages unanswered` |
| `--scope` | `<scope>` | only what belongs to personal or to work accounts: personal or work |  | `contacts timeline` |
| `--score` | `<helpful\|active\|engaging>` | the named ranking score preset; not with an explicit --measure |  | `stats contacts top`, `stats messages top` |
| `--secret-stdin` |  | a secret MAX sends back in X-Max-Bot-Api-Secret — asked for, or read from a pipe |  | `bot webhooks set` |
| `--selection` | `<json>` | the versioned resolved ranking selection returned by drilldown; authorisation is checked again |  | `searches create`, `stats contacts evidence`, `stats messages counters refresh`, `stats messages counters show`, `stats messages evidence` |
| `--send-as` | `<id>` | send as one of the identities `chats send-as` lists for the chat; required where the chat posts as someone else by default, refused where the messenger has none |  | `messages forward`, `messages send`, `polls create` |
| `--serve` |  | start `serve` in the background if it is not running (the default) |  | every command (planned) |
| `--server-time` | `<duration>` | stop waiting for the server after this long (default: 5s) |  | `search all` (planned), `search messages` |
| `--set` | `<id>` | the stickers in this set |  | `stickers list` (planned) |
| `--show-phone` |  | print the whole phone number |  | `account show`, `contacts profile` |
| `--silent` |  | deliver without a notification |  | `bot messages send`, `messages forward`, `messages send`, `polls create` |
| `--since` | `<id-or-time>` | from this message id, an ISO 8601 time, or 2h / 1d ago; each command says its default. **becomes `--since-time` everywhere — NEED-485** |  | `inbox` (planned), `review` (planned) |
| `--since-time` | `<time>` | from this ISO 8601 time, or 2h / 1d ago; each command says its default |  | `bot chats moderate`, `bot store fetch`, `chats moderate`, `contacts context`, `contacts timeline`, `messages sync`, `replies test`, `runs search`, `search conversations`, `stats charts`, `stats chats newcomers`, `stats chats retention`, `stats chats show`, `store export` |
| `--size` | `<n>` | messages to answer per batch, 10–200; 50 by default |  | `conversations batches next`, `conversations batches status`, `conversations build` |
| `--skip` | `<which>` | a folder leaves out chats that are muted, read or archived |  | `chats folders create` (tg-only), `chats folders update` (tg-only) |
| `--sms` |  | phone login: ask Telegram to send the code by SMS, not to the app; Telegram may still refuse |  | `session start` (tg-only) |
| `--solution` | `<text>` | with --quiz: what people see once they answered |  | `polls create` (tg-only) |
| `--source` | `<accounts>` | which accounts: personal, bots or all, a provider, or a list of provider:account as a hit shows it, a provider, a kind (messages, mail, notes, documents, meetings) or group:<name> — the same as in: in the query. **each search reads the accounts of its own kinds and names the rest in skipped — source-everywhere-plan.md** |  | `search all` (planned), `search conversations`, `search messages`, `search notes` (planned), `searches create`, `stats contacts responses`, `stats contacts top`, `stats messages counters refresh`, `stats messages counters show`, `stats messages discussion`, `stats messages show`, `stats messages top`, `stats messages unanswered`, `tags remove` |
| `--spoiler` |  | hide the --photo or video behind a spoiler until tapped |  | `messages send` (tg-only) |
| `--start` | `<param>` | the start parameter the bot or app reads; for chats start, a link's own ?start= when not given |  | `chats app` (planned), `chats start` (planned) |
| `--status` | `<status>` | filter diagnostic runs by outcome |  | `runs search` |
| `--sticker` | `<id>` | send this sticker, alone; stickers list finds its id |  | `messages send` (planned) |
| `--store-token` | `<profile>` | keep a returned authentication token only in this bot profile's OS keyring; never print it |  | `bot api` |
| `--sync-first` |  | first fetch new messages within the chat, time and message bounds |  | `bot contacts show`, `contacts context`, `search conversations`, `search messages`, `stats contacts top`, `stats messages show`, `stats messages top`, `tags auto` |
| `--sync-time` | `<duration>` | stop fetching after this long (default: 30s) |  | `search conversations`, `search messages`, `stats contacts top`, `stats messages counters refresh`, `stats messages show`, `stats messages top` |
| `--task` | `<id>` | a task, by its id or key as tasks list shows it |  | `tags add`, `tags remove` |
| `--template` | `<text>` | the reply template |  | `replies edit` |
| `--text` | `<text>` | the message's new text; - reads stdin |  | `bot callbacks answer` |
| `--text-file` | `<path>` | read the text from this file; - or none reads stdin |  | `attachments text set` |
| `--thread` |  | the stored reply chain and replies instead of time neighbours; falls back when no graph exists |  | `messages context`, `search messages` |
| `--thread-bytes` | `<n>` | at most this many bytes of whole messages and links in each context (default: 65536) |  | `messages context`, `search messages` |
| `--thread-hops` | `<n>` | at most this many links from the hit (default: 8) |  | `messages context`, `search messages` |
| `--thread-messages` | `<n>` | at most this many messages in each thread context (default: 50) |  | `messages context`, `search messages` |
| `--thread-within` | `<duration>` | messages within this long either side of the hit (default: 1d) |  | `messages context`, `search messages` |
| `--threads` | `<n>` | threads in all | `min(8, cores)` | `conversations embed` |
| `--timeout` | `<duration>` | give up on the whole command after this — 30s, 2m, 500ms |  | every command |
| `--timezone` | `<zone>` | the IANA timezone for calendar date boundaries. **replies edit uses this option for the IANA timezone for the working window** | `system IANA timezone` | `replies edit`, `search all`, `search conversations`, `search messages`, `search notes`, `searches create`, `stats charts`, `stats chats newcomers`, `stats chats retention`, `stats chats show`, `stats contacts responses`, `stats contacts top`, `stats messages counters refresh`, `stats messages counters show`, `stats messages discussion`, `stats messages show`, `stats messages top`, `stats messages unanswered` |
| `--title` | `<title>` | the new name — of a chat, a folder or a forum topic. **tasks add and tasks plan use this for the action and its object, in one line** |  | `bot chats admins add`, `chats folders update`, `chats update`, `tasks add`, `tasks plan`, `topics edit` (tg-only) |
| `--to` | `<chat>` | the chat to forward it to: an id, or part of a chat name. **the sentence says how to name a chat the messenger's way, so it differs on purpose (Help text rule 4)** |  | `messages forward` |
| `--topic` | `<id>` | address this forum topic: send or forward to it, read only it, or mark only it read. **Telegram group forums only; MAX explicitly refuses this option before sending** |  | `chats mark-read`, `messages forward` (tg-only), `messages send`, `polls create` |
| `--trace` |  | one line per request on stderr: ids and timings, never message content. **max logs one line per request, tg the connection's own lines: the same option, a different mechanism (Help text rule 4)** |  | every command |
| `--track` |  | also do it daily while serve runs |  | `chats members fetch` |
| `--transcribe` |  | hear voice messages not heard yet, on this machine; slow, the model must be downloaded. **max's own copy is worded differently until T6 moves the command onto the shared one (e13)** |  | `inbox`, `messages list`, `review` |
| `--type` | `<names>` | only these types. **each command names its own types — tasks add gives the new task question, request, mention or promise — and search notes internal or file — so it differs on purpose (Help text rule 4)** |  | `chats media` (planned), `search notes`, `stats tasks show`, `tasks add` |
| `--types` | `<value>` | Comma separated list of update types your bot want to receive |  | `bot watch`, `bot webhooks set` |
| `--unanswered` | `[duration]` | only questions to you or a group's admins that nobody answered, asked at least this long ago — 4h, 1d. **max's own `review` still takes bare hours until T6 moves it (e2)** | `24h` | `review`, `tasks agenda` |
| `--until` | `<time>` | only until then: a local time, or a duration from now |  | `chats mute` (planned) |
| `--until-id` | `<id>` | only up to this message id, inclusive; the newest by default. **tg's `bot store fetch` takes a message link here, the message the fetch starts at, inclusive** |  | `bot store fetch` (tg-only), `chats mark-read` |
| `--until-time` | `<time>` | through this ISO 8601 time, or 2h / 1d ago |  | `contacts timeline`, `stats chats newcomers`, `stats chats retention` |
| `--upgrade` |  | explicitly upgrade a basic group to a supergroup before enabling topics; its chat id changes |  | `topics enable` (tg-only) |
| `--verbose` |  | more detail in what is shown: -v ids, -vv everything known | `0` | every command |
| `--version` |  | print the version number |  | every command |
| `--voice` | `<file>` | send an Ogg Opus file as a voice message, alone, with no text |  | `bot messages send`, `messages send` |
| `--waiting` | `<duration>` | only chats where the owner wrote last at least this long ago | `7d` | `tasks agenda` |
| `--weights` | `<json>` | the complete ranking component weights; replaces preset weights when --score is given |  | `stats contacts top`, `stats messages top` |
| `--with-notes` |  | include your private notes, subject to contacts.notes.list permission |  | `contacts show` |
| `--within` | `<duration>` | the observation window after a known join; each report names what it measures |  | `stats chats newcomers`, `stats chats retention`, `tasks agenda` |
| `--words` | `<words>` | match any of these whole words, comma-separated; empty clears |  | `replies edit` |
| `--yes` |  | go ahead without the question an ask level puts before a write |  | every command, `account sessions end` (planned), `mcp` (planned), `mcp config` (planned) |

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

1. **Every list answers one envelope** in `--json`: `{ items, page, limit, hasMore }` —
   `renderPage` in [`src/cli/paging.ts`](../../src/cli/paging.ts) prints it. `--jsonl` streams the
   items one per line. A list never answers a bare array.
   - A list with no pages (`store status`, `server logs`) answers `page: 1`, `limit` the count and
     `hasMore: false` — `listed` in the same file.
   - A list paged by a message rather than a page number (`messages list`, `chats events`) answers
     `page: 1`; `hasMore` says whether there is more on the far side of the last item.
   - Fields about the whole list go beside the four, never instead of them (`models audio list`'s
     `directory`).
   - Commands are moving to the answer envelope built by `listOf` in
     [`src/cli/envelope.ts`](../../src/cli/envelope.ts) (so far `admin folders`):
     `{ items, page, next?, missing?, meta }`, with `page.next` first in `next` when more rows exist. A
     command that moves says so in the changelog.
   - `page` says how the source pages: `{ mode: "page", limit, has_more, next_page? }`, or
     `{ mode: "cursor", limit, has_more, next_cursor? }` for a source with its own position (`messages
     list`) — never a page number there. `--jsonl` prints `{"type":"item","data":…}` per item, then
     `{"type":"end","complete","issues"?,"page"}`, so a reader tells a whole stream from a cut one.
   - `meta` is `{ run_id, duration_ms, accounts?, complete, issues?, truncated? }`. `complete: false` with
     `issues: [{ code, source }]` (an error code each) says a source failed or was skipped; `truncated` says
     a size cap cut it; `page.has_more` says another page exists. A command that may answer partially
     declares `partial` (the searches) and exits 0; any other exits with the first issue's code, after
     printing what it read.
   - `next` holds at most two steps: the one to take, then one alternative. Each has `kind` (`command`,
     or `user_action` with no command) and `safe_to_auto_execute`, true only when its command writes
     nothing on the messenger (`effects.remote` is `none` or `read`; a local write such as a sync into the
     store does not count, NEED-1073). Steps are built from ids, counts and cursors this CLI holds, never
     from text a message, mail or document carried.
   - `inbox` and `review` are not lists: they answer one view grouped by chat, `{ chats: [{ …,
     messages }] }`, in both tools.
2. **A write answers what it did**: `{ operationId, … }`, the ids it touched after it. The same
   id is in the send journal.
3. **A one-thing view answers the object itself** (`account show`, `store info`).
4. **An error is one JSON object on stderr** in the machine modes —
   `{ "error": { "code", "reason", "message", "param"?, "details"?, "next"?, "retry", "run_id"? } }`, the same
   object MCP answers with `isError` — stdout stays empty, and the exit code says which kind of
   failure it was. `reason` is a registered id (`query.too-large`, `src/errors/reasons.ts`, or the code's
   own from cli-base); branch on `code` and `reason`, never on `message`. `details` holds only
   registered keys and never a cause. A person sees `✗ message` and at most one `→ next step` line;
   `--debug` adds the failure's whole record, cause and stack included. A failure that is not ours
   is `internal_error` (exit 1) with a fixed message: its own text can carry anything. Commander's own parse errors (an unknown command or option, a missing argument,
   a missing required option) are `validation_error` and exit 2, printed the same way; `--help` and
   `--version` exit 0. The codes are cli-base's and the same in every CLI:

   | Code | Meaning |
   |---|---|
   | 0 | ok |
   | 1 | internal error — a bug, not a refusal |
   | 2 | validation error — the command line is wrong |
   | 3 | configuration error |
   | 4 | authentication error |
   | 5 | permission error |
   | 6 | not found |
   | 7 | confirmation required |
   | 8 | rate limited |
   | 9 | timeout |
   | 10 | network error |
   | 11 | provider error — the messenger refused |
   | 12 | provider unavailable |
   | 13 | invalid response |
   | 14 | outcome unknown — a write may or may not have happened |
   | 130 | cancelled |

5. **A shared command answers the same shape in both tools.** What only one messenger knows goes
   under `providerMetadata`, never as a top-level field one tool has and the other lacks.
6. **`server status` answers one shape in both tools** (NEED-494 B). Not running is a result,
   `running: false`, exit 0.

   | Field | Meaning |
   |---|---|
   | `profile` | the profile asked about |
   | `running` | a server answers for it |
   | `pid` | its process |
   | `startedAt` | when it started |
   | `connected` | logged in, with updates arriving |
   | `connectedAt` | since when, where the tool knows it |
   | `by` | who started it: `unit` (systemd or launchd), `server` (`server start`), `hand` (`serve` typed in a terminal), `command` (max: a command that needed it) |
   | `version`, `cliVersion` | what the server runs, and what this tool is — they differ after an update, and a note on stderr says `server restart` |
   | `log` | where its log is |
   | `unit` | `{ name, path, installed, loaded, active, detail }` |
   | `stale` | `{ pid, startedAt }` — a lock or socket file was left by a server that is gone |

   Starting and stopping in the background is `server start` and `server stop` only; `serve` is
   the foreground command a unit or a person runs (rules 4 and 9).
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
   - **`--language` is removed when the forgiving default lands**: from `search messages`,
     `searches create` and MCP together, with its parity entry. `--exact` stays: it turns
     forgiveness off.
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

A long sync — a mailbox, a chat history, a Drive folder, a recording archive — is stopped by a kill, a reboot or a
provider's limit as often as it ends. Every CLI holds it to three rules:

1. **A kill loses nothing saved.** Work is saved per item or per page, in its own transaction, never at the end.
2. **A rerun goes on from where the last one stopped**, by default. It skips what is stored *and* does not redo
   the listing or paging that got there. Starting over is an option the owner asks for. drive's `--rescan` is
   the name in use; a second CLI that needs one takes the same word, added to cli-base's flag registry first.
3. **The status command says how far it is**, as the progress shape below, and on one line in text.

Where the position lives, in this order:

- **The store, when it already says.** tg and max: the held stretches of each chat (`fetchedKey`,
  `historyStartKey`), so `messages sync --all` passes a chat held to its newest message without asking for it;
  background runs are `store jobs`. zm: the monthly checkpoints of `recordings sync`.
- **Otherwise a checkpoint file**, `<state>/checkpoints/<profile>/<job>.json`, written with `saveCheckpoint` from
  `@wirecat/cli-core/background` and read with `readCheckpoint`. Its `cursor` is the tool's own (an IMAP mailbox's
  UIDVALIDITY and last UID, a page token); `done` and `total` count items. The write is atomic, and a torn file reads
  as no checkpoint, which costs one run from the start and never fails one. drive's saved plan in its state file is
  this checkpoint under another name.

**Progress** (`progressOf`, printed by `progressLine`): `{ job, profile, done, total, remaining, state, updated_at,
cursor_age_ms }`. `state` is `partial` or `complete`; `total` and `remaining` are `null` when the source does not
say how much there is. `store jobs show` answers it as `progress`.

Whether the last *scheduled* run failed is a different question: `recordRun` and `failingNotice` in
[the schedules](../../src/background/schedules.ts) answer it.

## Permissions

What a profile may do is one setting, `permissions`: a JSON object whose keys are command paths and
whose values are levels. It holds for a command the owner types and for an agent over MCP alike.

```json
{ "permissions": { "messages": "allow", "messages.delete": "ask", "contacts": "readonly" } }
```

1. **Four levels.**
   - `deny` — nothing, not even reading: the command answers `permission_error` (5) before it
     connects, and an agent is not offered its tool.
   - `readonly` — reads work, writes answer `permission_error`. On a key that only writes
     (`messages.delete`) it is `deny`.
   - `ask` — in a terminal, a y/N question that shows what will change, default no. A flag skips
     it: `--allow-dangerous` for a deletion, `--yes` for every other write. With no terminal and
     no flag the command answers `confirmation_required` (7). Over MCP,
     `ask` permits the requested write without a server form; separate moderation rule consent
     remains authoritative.
   - `allow` — goes ahead and never asks.
2. **A key is a command path**: `messages`, `messages.delete`, `chats.members.remove`,
   `account.sessions.end`. **The most specific key the owner set wins**; there is no wildcard, and a
   key starts with a resource, so a misspelled one is refused rather than ignored. Every command
   maps to exactly one key, checked by a test over `commands --json`:
   - a command that shows messages from outside `messages` counts as `messages` — `inbox`,
     `review`, `watch`, `serve`, `messages sync`, `store export|search`, the MCP resources and prompts, and
     what tells who sent what — `attachments list`, `chats documents list` (planned);
   - housekeeping is never gated — `config`, `session`, `doctor`, `commands`, `complete`,
     `upgrade`, `skill`, `models`, `server`, `runs`, `sends`, `recipients`, `mcp`, and `store`'s
     own maintenance.
3. **The defaults allow almost everything**, so the tool works without questions. Only what cannot
   be undone asks:

   ```json
   { "messages.delete": "ask", "account.sessions.end": "ask" }
   ```

   A default is never tightened without the owner's word. **A built-in default only ever tightens**:
   against a broader key of the owner's, the stricter of the two holds — `messages: readonly` still
   stops a deletion, and `messages: allow` keeps its question until `messages.delete` is named.
4. **Limits no level lifts**: an agent never deletes for everyone and never ends other sessions.
5. **A group's moderation rules use the same four levels** for each kind of action (delete,
   remove, accept, decline), `readonly` meaning "report it, do nothing". A rule's level can only be
   as loose as the profile's level for `chats.moderate`.
6. **`permissions` is the only access setting.** A file that still holds `read_only` or `allow` is
   refused as an unknown setting, like any misspelled one.

7. **A bot's keys are the personal ones under `bot`**: `bot.messages.send`,
   `bot.chats.members.remove`, `bot.webhooks`. A profile can allow its bot what it does not allow
   its personal account, and the other way round; `bot` alone covers every bot command. The default
   is the personal one's: `bot.messages.delete: ask`. Housekeeping under `bot` is never gated —
   `bot auth`, `bot list`, `bot recipients`, `bot sends`, `bot mcp`.

What it does not decide stays separate: the recipient list (which chats), `sends_per_hour` (how
many), `--allow-any-file` (which files).

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

`stats charts --output` selects SVG or PNG by the file extension; images never go to stdout.
The stored-only `stats_charts` tool accepts optional `format: json|png` (default `json`).
PNG adds `image/png` content and JSON text `{ chart, image: { format, width, height } }`;
it writes no file and uses the same `messages` read permission.

1. **Three tools, not one per command** (NEED-766): `<tool>_tools_search` finds commands by words
   and gives each one's arguments and the shape of its answer (`output`: the envelope of its entity, or
   any envelope); `<tool>_read` runs a command that only reads and `<tool>_write`
   one that changes something, as `{ "command": "messages list", "arguments": { … } }`. Both declare
   the envelope (a list `{items, page, …}` or one thing `{item, …}`) as their `outputSchema`. A command
   is its CLI path. The bot server's three are `<tool>_bot_tools_search`, `<tool>_bot_read` and
   `<tool>_bot_write`, and its commands are the path under `bot`. `status` answers what the server is.
   `conversations refresh` runs what `search conversations --refresh` runs before it searches
   (NEED-551 A). The list never changes during a connection.
2. **Arguments are the command's options in snake_case**, with the option's name: `--operation-id` is
   `operation_id`, `--since-time` is `since_time`, `--before-n` is `before_n`.
3. **Every command says whether it writes**; `read` refuses a writing one and `write` a reading one.
4. **A command is found and run by its [permission](#permissions)**, never by a flag of its own:
   `deny` hides it, `readonly` hides the writing ones, `ask` and `allow` act — no form, since nobody
   is at a terminal to answer (NEED-772, NEED-773). `mcp` takes no flag that grants or confirms access.
5. **Unknown arguments are refused before execution.** A retired schedule field must never turn
   a scheduled write into an immediate one.
6. **A tool and its command run the same service method**, so they answer the same result and the
   same error for the same input.

## Help text

`<cli> commands search messages --json` describes one command; `<cli> commands messages --json`
includes the group's descendants. Give one command path per call; inspect different groups in
separate calls. Scoped discovery keeps `globalOptions` and `exitCodes`, adds
the canonical `scope` path, and lists options from non-root ancestors in `inheritedOptions`
as `{ path, options }` entries. Aliases resolve to canonical command names. Unknown or hidden
paths return `validation_error` (exit 2), with the valid commands at that level. The full tree
remains available through `<cli> commands --json`, with no scoped fields.

1. **A description says what the command does, as the user sees it**, in one line, lower case, no
   full stop, no internal term — no wire field, no port, no adapter.
2. **A shared command has the same sentence in both tools.** It is one command; the shared factory
   writes the description, and a CLI changes it only to name its messenger.
3. **An option's description says what it changes and its unit**: `--pause <duration>` "wait this
   long between pages".
4. **A shared option has one sentence in both tools**, checked by the parity workflow
   (`cli-core-parity wording <max.json> <tg.json>`; each file is known by its `cli`, so it takes
   any number, in any order). A difference is allowed only where the sentence names something the messenger's own way — how to name a chat, which rights or events it
   has — and the option's catalogue `note` says so; a note also marks a difference still open, and
   names who closes it.

## Layers and sharing

Code structure follows the shared
[modularity standard](https://github.com/WireCatLabs/cli-base/blob/main/docs/dev/MODULARITY.md):
provider-neutral capabilities in cli-core, general CLI infrastructure in cli-base, narrow ports,
thin CLI/MCP handlers and explicit resource ownership. The local
[architecture map](ARCHITECTURE.md#responsibility-and-dependency-boundaries) names their modules.
The guidelines apply to changed responsibilities; they do not claim that all existing code has
already been refactored or that file-size guidance is enforced by lint.

1. **Shared by default.** Provider-neutral behavior goes here. Meeting discovery and preparation
   belong here even when Zoom is the first consumer; provider bindings stay in their applications.
   A feature one messenger has
   and the other could have (topics, polls) is still a port group and a shared command; it is
   CLI-local only when the other messenger cannot have it — MAX's socket server, Telegram's app
   registration.
2. **Layers:** command or MCP tool → service → port group → adapter. A command never calls an
   adapter method directly for a use case a service owns ([ARCHITECTURE](ARCHITECTURE.md#services)).
   A new adapter method goes into a named group in `port.ts`, never the core.
3. **No messenger type above the adapter.** Here, `biome.json` refuses the import; in a CLI, the
   adapter translates into the domain model and nothing above it imports the messenger library.
4. **A CLI replaces a use case, not a command** — through `Messenger.services`, so its command and
   its MCP tool both get the replacement.

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
`clis` names them (`["max", "tg"]`). Each CLI's CI checks its own `commands --json` against its
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
by hand, and inside full validation (`ci.yml`), which each push to `main`, the release and the monthly
run start. It does not run on pull requests, and there is no daily run. It
builds tg-cli and max-cli from their `main` and runs the same check, so a row flipped early fails
here, before the release that would carry it — not weeks later, when a CLI upgrades. The published
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
