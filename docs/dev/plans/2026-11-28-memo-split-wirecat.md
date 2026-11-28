# Plan: memo becomes wcat, local files move to a files CLI

Status: draft for review, nothing built. It answers the RFC in
[#3383](https://github.com/WireCatLabs/cli-core/issues/3383) by Petya (pikerr).

Owner's ruling, 2026-11-28: yes. The local files part leaves memo, and memo is renamed to wirecat. The command is
`wcat`, the GitHub repository is `wirecat`. It ships as one coordinated breaking release (3.0 or 4.0). People, bots,
organizations, memories, notes and the rest go where they fit best, decided with evidence.

Code facts below were read at these commits: cli-core `de644f313`, cli-memo `1b2c9ae`, cli-base `f8b8ac0`,
wirecat-desktop `9d03511b`. "Checked" means a command was run. "Inferred" means it was not.

The plan lives here, not in cli-memo: the RFC is in this repository, plans that span repositories live in
`docs/dev/`, and cli-memo is the repository that gets renamed.

## 1. What memo is today

`memo` has 59 command groups and 285 subcommands
([commands.md](https://github.com/WireCatLabs/cli-memo/blob/1b2c9ae4160eee131fbfd354a8b9a7fcef870602/docs/commands.md)).
They fall into three kinds.

| Kind | Groups |
|---|---|
| Across sources (the knowledge tool) | `context`, `show`, `search`, `answers`, `people`, `bots`, `organizations`, `projects`, `relationships`, `tasks`, `stats`, `reminders`, `vocabulary`, `memories`, `mentions`, `facts`, `review`, `actions`, `agents`, `meetings`, `events`, `messages`, `mail`, `documents`, `tags`, `groups`, `digest`, `templates`, `domain-lists`, `models`, `records`, and the money groups `invoices`, `payments`, `orders`, `pipelines`, `deals`, `leads`, `stages`, `products`, `contracts`, `subscriptions`, `wallets`, `transactions` |
| Local files | `notes`, `folders`, `sources`, `import`, the notes part of `sync` |
| Plumbing that every CLI has | `config`, `doctor`, `upgrade`, `schedule`, `commands`, `skill`, `guide`, `runs`, `store`, `mcp` |

The local files code is `src/notes`, `src/sources` and `src/import`: about 5,000 of memo's 32,700 source lines
outside tests (checked with `wc -l`). So after the split about 85% of memo stays in wcat. Most of the logic is in
cli-core already. memo mounts it.

## 2. Corrections to the RFC

The RFC is right about the direction. Four points need a correction.

1. **memo is not a mix of two unrelated jobs.** It is the knowledge tool by design.
   [TOOL-BOUNDARIES.md](../TOOL-BOUNDARIES.md) (owner, 2026-10-11) gives it the row "Knowledge tool: memo, to be
   renamed" and the rule "a command lives where its data comes from". The facade is not five commands (search,
   context, mcp, db, doctor). It is everything in the first row of the table above. The files CLI is the small part.
2. **cli-core already owns every store migration.** The migrations are in `drizzle/` and
   [src/store/migrations.ts](https://github.com/WireCatLabs/cli-core/blob/de644f313eacadb57c2f16ce2b19a0bdd791ddb2/src/store/migrations.ts#L109).
   Every CLI that opens the store for writing runs them with its own copy of cli-core. memo does not drive them. A
   `wcat db` command would not change that, because tg and drive still open the store themselves. Every CLI already
   has the `store` group for maintenance.
3. **The v74 against v72 refusal is most likely the safety check working** (inferred, no incident report found).
   [`refuseForeignOrNewer`](https://github.com/WireCatLabs/cli-core/blob/de644f313eacadb57c2f16ce2b19a0bdd791ddb2/src/store/migrations.ts#L87)
   refuses a store when its `minCompatible` is above what the CLI speaks. Version 73 raised `minCompatible` to 73
   ([COORDINATION.md](../COORDINATION.md#store-migrations)), so a drive-cli that spoke 72 refuses a store that any
   newer CLI migrated. The cause is CLIs on different cli-core versions, not memo. The fix is the coordinated release
   we already do. Today memo, drive-cli, tg-cli and mail-cli are all on cli-core 2.0.0 (checked with `npm view`).
4. **`wcat` already exists.** It is cli-base's umbrella command: `wcat <tool> …` runs `wcat-<tool> …`, as `git foo`
   runs `git-foo` ([REFERENCE.md](https://github.com/WireCatLabs/cli-base/blob/f8b8ac018e9015bea8c549c1ca045bfc6a607456/docs/REFERENCE.md)).
   Every CLI writes a small `wcat` launcher into the global bin folder. `wcat doctor`, `update`, `upgrade` and `app`
   are reserved "for a later version"
   ([dispatch.ts](https://github.com/WireCatLabs/cli-base/blob/f8b8ac018e9015bea8c549c1ca045bfc6a607456/src/wcat/dispatch.ts#L215)).
   So wcat is not a new binary. memo's commands fill the umbrella that is already there.

## 3. Design

### 3.1 Names

| What | Name | Why |
|---|---|---|
| Command people type | `wcat` | Owner's choice. No Debian package installs `/usr/bin/wcat` (packages.debian.org contents search, checked 2026-11-28) |
| npm package | `@wirecat/wirecat` | Free on npm (checked). Unscoped `wcat` is taken by an unrelated 0.1.1. Desktop trusts tools by the `@wirecat/` prefix (`described.rs:67`) |
| Program on disk | `wcat-wirecat` | See 3.2. People never type it |
| GitHub repository | `WireCatLabs/wirecat`, renamed from `cli-memo` | Free (checked with `gh repo view`) |
| Files CLI | `files`, package `@wirecat/files-cli`, repo `WireCatLabs/files-cli`, program `wcat-files` | See 3.3 |
| Docs | `wirecat.dev/<lang>/docs/wcat` and `/docs/files` | Pages are named by command, as `/docs/tg` is |
| MCP server | `wirecat` (`claude mcp add wirecat -- wcat mcp serve`) | Tools become `wcat_read`, `wcat_write`, `wcat_tools_search`. cli-core builds them from the command name ([instructions.ts](https://github.com/WireCatLabs/cli-core/blob/de644f313eacadb57c2f16ce2b19a0bdd791ddb2/src/mcp/instructions.ts#L30)) |

The name `wirecat` stays off PATH. It is the Desktop's apt package name (`wirecat`, binary `wirecat-desktop`).

### 3.2 How `wcat` becomes memo

A package cannot simply declare `bin: wcat`. npm refuses to install a bin over a file it did not link. Checked: a
local package with `bin.wcat`, installed with `npm i -g --prefix` over a planted launcher file, fails with
`EEXIST: file already exists` (npm 11.17.0). The same happens for two packages that both declare `memo`. Every
person who has any WireCat CLI has that launcher file now.

So the change goes into cli-base, and it is small:

1. **The launcher prefers `wcat-wirecat`.** A new launcher format starts `wcat-wirecat` when it is in the same bin
   folder, else any `wcat-*` as now. `ensureLauncher` already rewrites a launcher in an older format, and
   `wcat-wirecat` carries the newest cli-base, so its first start updates the launcher. No other CLI has to be
   released first.
2. **The order of words.** `wcat` reads the first word in this order: its built-ins (`help`, `version`,
   `shortcuts`), then wcat's own groups when `wcat-wirecat` is installed, then an installed tool `wcat-<word>`. So
   wcat's groups act as more built-ins, and a `wcat-people` program on PATH can never take over `wcat people`.
   `RESERVED_NAMES` gets the group names too, so a new tool is never given one.
3. **The reserved built-ins get their owner.** `wcat doctor` and `wcat upgrade` become memo's `doctor` and
   `upgrade`, widened to every installed WireCat tool. Without `wcat-wirecat` installed they keep today's answer.
4. **`FIRST_PARTY_TOOLS`** lists `wirecat` and `files` and drops `memo`. `wcat --help` hides `wirecat` from the
   tool list, because its commands are the top level. This change waits for the release day (section 4), because
   `wcat --help` prints the install command of each missing first-party tool.
5. **The first start.** The package cannot declare `wcat`, so the launcher must be written by a run. npm runs the
   package's `postinstall` on a global install (memo's
   [postinstall](https://github.com/WireCatLabs/cli-memo/blob/1b2c9ae4160eee131fbfd354a8b9a7fcef870602/install/postinstall.mjs)
   already does work there), so it writes the launcher. pnpm and bun may not run it (inferred, phase 4 checks it).
   Then `memo upgrade`, Desktop and the install page run `wcat-wirecat --version` once, which writes it. Desktop
   always runs `wcat-wirecat` itself and never depends on the launcher.

One name collides: memo's `mail` group (`mail findings`, `mail review`) against the mail CLI. With the order above a
`mail` group would hide `wcat mail`, so the group moves to `wcat review mail` and `wcat review findings
list|show|add`. `memo mail …` keeps working through the alias. No other memo group has the name of a tool (checked
against `FIRST_PARTY_TOOLS` and cli-core's `WIRECAT_TOOLS`).

### 3.3 The files CLI: `files`, not `fs`

- `fs` is taken on Linux. Debian's `openafs-client` installs `/usr/bin/fs` (packages.debian.org file list,
  checked). In Node, `fs` also reads as the built-in module.
- No Debian package installs `/usr/bin/files` (contents search, checked).
- `files` says what it holds, in the words our docs use: notes folders, Obsidian vaults, PDF and Word files.
- The package follows the newer pattern `@wirecat/<name>-cli`, as `tg-cli` and `drive-cli` do.

It is a source tool like tg or drive. It brings local files into the store and searches its own notes.

### 3.4 Where each command goes

The rule from TOOL-BOUNDARIES decides: data one source brings in belongs to that source tool. Data that spans
sources, or that no source brought in, belongs to the knowledge tool.

| memo today | After | Reason |
|---|---|---|
| `notes`, `folders`, `sources`, `import` | `files` | Files on this computer, and the readers for PDF, Word and transcripts |
| `sync` | `files sync` syncs notes. `wcat sync` embeds stored mail, runs `people scan`, and runs `files sync` when files is installed | Each tool syncs what it brings in, and `wcat sync` still does all that `memo sync` did |
| `jobs` | `wcat` | `jobs start` runs the whole sync ("sync notes and embed new mail every 5 minutes"), so it stays with `wcat sync` |
| `search notes`, `tags`, `tasks` | both | Shared builders. TOOL-BOUNDARIES keeps them in every source tool |
| `mail findings`, `mail review` | `wcat review findings`, `wcat review mail` | The `mail` word belongs to the mail CLI in `wcat` |
| `documents` | `wcat` | It lists documents of every account: Drive, folders, imports |
| `people`, `bots`, `organizations`, `relationships` | `wcat` | People and bots span every source |
| `memories`, `facts`, `mentions`, `vocabulary`, `reminders` | `wcat` | Written by agents and the owner, or found across sources |
| `records`, money groups, `pipelines`, `deals`, `leads`, `stages` | `wcat` | CRM and records imports from several sources |
| everything else in the first row of section 1 | `wcat` | Across sources |
| plumbing | both | Every CLI has it |

In phase 3, check whether memo's `notes` group is cli-core's shared notes builder (the one tg mounts) or memo's own.
If it is shared, `wcat` keeps the shared part (a note on a person) and `files` gets the folder part.

### 3.5 Old names and how long they live

The new package ships the programs `memo` and `wcat-memo` as aliases of `wcat-wirecat`.

- `memo <words>` runs `wcat <words>`. A command that moved to `files` runs `files <words>` when it is installed, else
  it names the install command.
- When it is started as `memo`, the program takes its command name from how it was started, so its MCP tools keep
  their old names (`memo_read`, `memo_write`). This is phase 4 work. So
  `claude mcp add memo -- memo mcp serve`, agents' permission lists and the n8n node keep working.
- It prints one line to stderr once a day: "memo is now wcat". Never in `--json` output, and never on an MCP stdio
  channel.
- Timers written by `memo jobs` and `memo schedule`, and Desktop prompts that say "Run memo skill show …", keep
  working through the alias. They are not rewritten.
- The aliases go in the following major release (open question 3).

### 3.6 What keeps its old name inside

The rename that people see is decided. These names are not visible to people, and renaming them moves data for no
gain, so the plan keeps them (open question 2):

- `appName: "cli-memo"` and the `MEMO_` environment prefix
  ([app.ts](https://github.com/WireCatLabs/cli-memo/blob/1b2c9ae4160eee131fbfd354a8b9a7fcef870602/src/app.ts#L7)).
  They decide the config and state folders and the keyring service, where memo keeps the AI model key. mail-cli reads
  memo's state folder `mail-trash` by that name (`src/mail/changes.ts:184` in mail-cli).
- Ids stored in the store: `memo:bulk`, `memo:envelope:…`, the bot `memo-scan`, systemd units `memo-*`.
- Desktop's internal catalog id `memo`. Desktop keys saved state on it. The visible fields change.
- The n8n node's internal name `wireCatMemo` and its credential type. Renaming them breaks saved workflows. Its
  display name changes.

The store needs no migration for the split. Nothing here raises `minCompatible`.

The files CLI's readers need the AI model key. That key is already shared: cli-core's `models ai` keeps it under the
service `WireCat` ([AI model plan](2026-11-09-ai-model-setting.md)), so files reads it the same way and no keyring
entry is copied. memo's older `models keys` entries under `cli-memo` stay with wcat. Phase 3 checks that no reader
files takes over still reads them.

### 3.7 GitHub and npm

- **Rename the repository** with `gh repo rename wirecat`. GitHub redirects the web pages, issues and git remotes.
  It does not redirect `uses:` of an action, and a new repository named `cli-memo` would break the redirects
  ([GitHub docs](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)).
  No WireCat workflow uses cli-memo as an action (checked). n8n's CI installs the npm package, not the repository.
- **Trusted publishing** is bound to the organization, the repository and the workflow file name, and
  "`repository.url` in `package.json` must exactly match your GitHub repository"
  ([npm docs](https://docs.npmjs.com/trusted-publishers)). The docs do not say what a rename does to an existing
  connection, so the plan does not rely on it. The last `@wirecat/cli-memo` release ships before the rename. The
  new package gets its first publish with `bin/release --first`, then a trusted publisher through the
  `npm-trusted-publisher` skill. The same for `@wirecat/files-cli`.
- **Deprecate** `@wirecat/cli-memo` with `npm deprecate` once both new packages are live, with the one command to
  switch.
- **MCP registry:** a new `server.json` named `dev.wirecat/wirecat`. The old entry `dev.wirecat/cli-memo` is still at
  version 0.113.0. Mark it deprecated if the registry allows that.

### 3.8 Desktop

Desktop reads most of memo from `catalog/tools.json`, so most of the change is data. About 30 places name memo in
code.

- **Catalog:** the memo entry (line 1787) gets the name, `package`, `repo` and `docs` of wcat, and `bin`
  `wcat-wirecat`. A new `files`
  entry takes `notesSetup`, `search notes`, `searchHarder --only notes` and `sync --only notes`.
- **Code that changes behaviour:**
  - `memo_server.rs:59` sends memo's commands through `commands --serve`. It keeps the id `memo` and starts the new
    program.
  - `mcp.rs:76` counts an MCP server as WireCat's when its name is the tool's `bin`. It needs an MCP name field
    (`wirecat`) and must still accept `memo`.
  - Reason ids `memo.old`, `memo.too-old` and `memo.refused` stay. The UI translates them.
  - The local files split points in TypeScript: `domain/archive.ts:47` and `shared/SourceIcon.tsx:8`.
  - Guides: 12 guides need memo and run about 19 `memo …` lines.
- **Install:** when Desktop finds `@wirecat/cli-memo`, it removes it first, then installs `@wirecat/wirecat`, and
  `@wirecat/files-cli` when notes folders are set. It then registers the MCP server as `wirecat`.
- **Size:** about 90 visible strings in Rust, 65 literals in TypeScript, and in tests 220 Rust lines, 481 TypeScript
  lines and 21 fixture files.

### 3.9 Everything else that names memo

| Repository | What changes |
|---|---|
| cli-core | The `memo` entry in `src/ports/wirecat-tools.ts:56`, `MEMO_SCENARIOS` in `src/cli/guide.ts:34`, and about 35 hints users see ("install @wirecat/cli-memo, then memo search mail" in `search-command.ts:36`). They produce the "Works with" line and help text in every CLI. Stored ids stay (3.6) |
| other CLIs | Nothing by hand for the help text: each CLI's next cli-core bump regenerates `contracts/help.snap` and `docs/commands.md`. By hand: `scripts/audit.sh` in 5 CLIs, `config/parity-groups.json`, the install hints in `docs/search.md` of tg, max and wa, `bin/b24-import:108` and `bin/gcal-live-check:119`, `zoom-cli/src/contract-overrides.ts:50`, and mail-cli's `--format memo` |
| cli-docs | English pages are copied from the tool repository by `pnpm sync` (`tools.json:131`), so they follow the rename. RU and ES: 50 files in `translations/memo/`, moved to `wcat/` and `files/`. Sidebar `meta*.json`, `lib/seo-copy.json` and `registry/official-manifests.json`. Redirects are meta-refresh stubs in `public/<lang>/docs/`: about 25 pages times 3 languages from `/docs/memo/*` |
| claude-plugins | `plugins/wirecat-memo` becomes `plugins/wirecat` with the skill `wirecat`. A new `plugins/wirecat-files`. `bin/sync-skills` reads the package and skill names from `plugin.json`. There is no `.mcp.json` to change |
| n8n-nodes-wirecat | Display texts, `memo_read`/`memo_write` in `run.ts:78` become `wcat_*` (the old names keep working through the alias), the CI install line. Internal names stay (3.6) |
| cli-template | `kit/src/new.ts:70`, `config/parity-groups.json`, `docs/dev/reference-clis.md` |
| memo's skills | `skills/cli-memo` becomes `skills/wirecat`. `wcat skill install` replaces an installed `cli-memo` skill it wrote. `mail-triage`, `morning-digest` and `task-triage` move with it |
| cli-private | A `highlight` note in `community/digest/NOTES.md` for the release, and the announcement post in Slava's voice |

## 4. Phases

Each phase is one pull request per repository unless it says more. Any session's release carries everything on
`main` ("merge freely, release in batches", [COORDINATION.md](../COORDINATION.md#releases)), so a change that names
packages not yet on npm must not reach `main` early. Hence two kinds of pull request:

- **Merge early:** a change that does nothing until the new packages exist. Only the launcher and dispatch part of
  phase 1, and the new files-cli repository of phase 3.
- **Open until the release day:** everything else. The pull requests are reviewed and green, and merge in the order
  below. Announce the day on [#3157](https://github.com/WireCatLabs/cli-core/issues/3157) first.

| Phase | Repository | What the pull request does | When it merges | Estimate |
|---|---|---|---|---|
| 1a | cli-base | Launcher prefers `wcat-wirecat`, the word order, `doctor` and `upgrade` handed to wcat, `RESERVED_NAMES` | Early, a minor. It does nothing while `wcat-wirecat` does not exist | 0.5 to 1 day |
| 1b | cli-base | `FIRST_PARTY_TOOLS` lists `wirecat` and `files`, drops `memo` | Release day | with 1a |
| 2 | cli-core | The tool list entry and the hints say `wcat` and `files`, with a test that no hint names `memo` | Release day | 0.5 day |
| 3 | files-cli, new | Made from cli-template with the `new-cli` skill. Takes `notes`, `folders`, `sources`, `import` and the notes sync, their tests and docs. On first start it copies the `notes` section from memo's config. First publish and trusted publisher on the release day | Early in its own repository, unpublished | 2 to 3 days |
| 4 | cli-memo, renamed wirecat | Removes what phase 3 took. Package `@wirecat/wirecat`, programs `wcat-wirecat`, `memo`, `wcat-memo`, command name `wcat`, the `review mail` move, the aliases and forwarding, the first-start launcher, skill and `server.json` | Release day, after phase 5 is published. Until then memo keeps releasing from `main` | 2 days |
| 5 | cli-memo | The final `@wirecat/cli-memo`. `memo upgrade` switches: removes `@wirecat/cli-memo`, installs `@wirecat/wirecat`, and `@wirecat/files-cli` when notes folders are set, with the package manager that installed memo. A start says "run memo upgrade" once a day, from a date in the code, with no npm call | Release day, first | 0.5 day |
| 6 | wirecat-desktop | Section 3.8 | Release day | 2 to 3 days |
| 7 | cli-docs, claude-plugins, n8n-nodes-wirecat, cli-template, other CLIs | Section 3.9 | Release day, docs last | 2 days |

Total: about 10 to 12 days of work, in about two to three weeks with reviews and CI.

### Release day order

1. Announce on #3157. Merge phase 5 and release the final `@wirecat/cli-memo` from `cli-memo` `main`. Its
   `memo upgrade` checks that `@wirecat/wirecat` is on npm and says "not yet" when it is not.
2. Merge phase 4 and rename the repository. First publish of `@wirecat/files-cli`, then `@wirecat/wirecat`, with
   `bin/release --first`. Trusted publishers for both.
3. Merge phases 1b and 2 and release cli-base and cli-core with whatever else is on `main`.
4. Desktop release.
5. Docs deploy with the redirects, then the plugins and the n8n node.
6. `npm deprecate @wirecat/cli-memo`. Digest note and announcement.
7. Other CLIs pick up the cli-core text on their next bump. No release only for this.

### How people move

- **Desktop:** automatic. The Desktop release does the switch on its next tool check.
- **CLI:** one command, `memo upgrade`. From a version before the final one it upgrades to the final one first,
  which says to run `memo upgrade` once more. By hand it is
  `npm rm -g @wirecat/cli-memo && npm i -g @wirecat/wirecat @wirecat/files-cli`.
- **Config, data and keys:** nothing moves (3.6). The store is the same file.
- **Agents:** `memo …` and `memo mcp serve` keep working until the aliases go.

### What can be skipped

- A `wcat db` or `wcat migrate` command. cli-core owns migrations, and every CLI has `store`.
- Renaming `@wirecat/cli-core` (the RFC defers it too).
- Every internal rename in 3.6.
- Folding `jobs` into `schedule`. It is a cleanup for later.
- Rewriting timers and prompts that say `memo`. The alias runs them.
- Phase 5, if CLI users may run the two npm commands by hand. It is small, so the plan keeps it.

## 5. Open questions for the owner

1. **NEED: does the split ride cli-core 3.0, or come after it?** cli-core 3.0 is not released, and its breaking
   changes are merged (#3428 to #3438, the install size plan). The split needs no store or cli-core break.
   - A: ride 3.0. 3.0 waits about two weeks for phases 3 to 6.
   - B: release 3.0 as it is, and ship the split as the next coordinated release (4.0 if cli-core needs a major
     then, else a release of the CLIs only).
   - Recommendation: **B**. 3.0 is being verified now, and the split does not need it.
2. **NEED: keep the internal names (3.6)?** This is not the rename people see, which is decided. It is about names
   only programs see.
   - A: keep `cli-memo` folders, the `MEMO_` prefix, the keyring service and stored ids.
   - B: rename them too, with a move of config, state and keyring entries on first start, and a migration for the
     stored ids.
   - Recommendation: **A**. Nobody sees them. B moves keyring secrets, rewrites stored ids, and breaks mail-cli,
     which reads `cli-memo/mail-trash` by name.
3. **NEED: how long do `memo` and the `memo_*` MCP tool names live?**
   - A: until the next major after the split, and at least three months.
   - B: no end date.
   - C: none, `memo` stops on the release day.
   - Recommendation: **A**. Timers, agent configs and n8n workflows carry the old name, and three months covers a
     Desktop update cycle.
