# Changelog

Notable changes to `@wirecat/cli-core`, one section per version, newest
first. Versions follow [semantic versioning](https://semver.org/); before `1.0.0` a minor release may change
the API.
Versions before 0.8.0 are in the [git tags](https://github.com/WireCatLabs/cli-core/tags).

Every entry says what changed as a caller sees it, why, and what to watch for — the rules are
[`docs/dev/CONVENTIONS.md`](docs/dev/CONVENTIONS.md#the-changelog).

## 0.19.4 — 11.10.2026

### Fixed

- Package references, documentation and fixtures use the WireCat namespace throughout.


- The owner-migration helper covers meetings, testing, Zoom and the shared organization repositories, so their links and package names migrate with the original CLIs.

## 0.19.3 — 10.10.2026

### Fixed

- **Zero command deadlines abort synchronously** before a body can execute, matching the documented
  immediate deadline instead of scheduling a timer that could lose to a fast command. They create
  no sleep or timer; an already aborted parent retains its cancellation reason.

## 0.19.2 — 10.10.2026

### Added

- **Portable command control helpers** expose `fieldsOf`, `projectFields`, `createOutputBuffer`
  and `createDeadline` from the root export. Field projection retains list and operation metadata;
  a bounded UTF-8 buffer delays data until hosts finish cleanup. Deadlines use injected sleep and
  cancellation, waiting for the body to settle before callers close resources. Callers must propagate
  the signal, dispose the deadline and discard buffered output on failure; no provider/store lifecycle
  or automatic retries are imported.

### Fixed

- Windows maintenance commands support portable relative PATH entries and custom or sanitized command-processor environments while preserving separate arguments.

### Security

- Release checks include source and secret analysis; critical production advisories and critical source findings block publication. Workflow findings are reported for review. PR security remains the fast secret scan.

## 0.19.0 — 10.10.2026

### Fixed

- Windows updater and MCP setup commands resolve through absolute PATH entries and use an explicit command processor, avoiding accidental execution from the current folder. POSIX resolution is unchanged.

### Added

- `/update` exports `executableOnPath` and `executableEnvironment` for consumers using the same Windows command resolution.

## 0.18.2 — 10.10.2026

### Changed — may break callers

- **The project is now licensed under Apache License 2.0.** See `LICENSE` for the terms.

## 0.18.1 — 10.10.2026

### Fixed

- **The shared spelling list knows `wirecat`.** `cspell` no longer flags the new package scope in READMEs.

## 0.18.0 — 10.10.2026

### Changed — may break callers

- **The package is now `@wirecat/cli-core`, and the repository is `WireCatLabs/cli-core`.** Install
  `@wirecat/cli-core` and change imports from `@wirecat/cli-core` (and its subpaths) to `@wirecat/cli-core`;
  the code is the same as 0.17.3. `@wirecat/cli-core` gets no new versions. Call the reusable workflows
  as `WireCatLabs/cli-core/.github/workflows/...`.

## 0.17.3 — 09.10.2026

### Changed — may break callers

- **Production dependency and workflow security checks run before releases.** Call the reusable
  `release-checks.yml` workflow from each release workflow and require it before building. `node-ci.yml`
  keeps lint, typecheck, coverage, build, Bun and secret scanning on changes.

### Fixed

- **Display sanitization makes Unicode tags and byte-order marks visible.** Subdivision flag emoji
  stay intact. CLI machine output continues to preserve original strings.

## 0.17.2 — 07.10.2026

### Added

- **`indent(text, spaces)` shifts every line of a block right.** A step's body under its heading, or a
  QR code, can sit indented in a setup screen. Empty lines stay empty, so no trailing spaces are printed.

## 0.17.1 — 04.10.2026

### Fixed

- **`cli-dev docs-check` and `markdownFiles` skip what is not a file or a folder.** A device or a
  pipe named `*.md` used to be read, and the check crashed. Claude Code's Bash sandbox lays devices
  over names in the working folder (`.claude/loop.md`, `.claude/skills`), so the check failed in
  every agent session with the sandbox on. A symbolic link to a file is still listed; a link to a
  folder is still not followed.

## 0.17.0 — 03.10.2026

### Changed — may break callers

- Consumers switching exhaustively over `SchemaNode` or API parameter locations must handle explicit unions and RPC body parameters. Existing HTTP models generate the same artifacts.

### Added

- API generators preserve explicit unions and Boolean literals, validate nested references, and emit schema definitions for shared command input traversal. RPC parameters can belong to the JSON body; multipart references retain their format. Source adapters can mark secret fields so consumers keep them out of generated CLI arguments.

## 0.16.0 — 02.10.2026

### Added

- **`@wirecat/cli-core/mcp` installs and checks local stdio MCP entries.** A CLI can add its existing
  MCP server to Codex or Claude Code through those clients' own commands and probe the handshake and
  tool list without calling a tool. Existing entries are refused, so callers must remove one in the
  client before changing it.
  Client commands use `cross-spawn` so npm's Windows `.cmd` shims can be started.

## 0.15.0 — 01.10.2026

### Added

- **`annotate(command, { mutates: true, local: true })`** marks a write that changes only this
  machine — a file, the keyring — and never the service. `CommandInfo.local` carries it, and
  `mutates` stays true, so a caller that tells reads from writes still sees a write.
- **`commandsPage` text takes `mutatesLocal`**, the line shown under such a command instead of
  `mutates`. Without it a local write gets no line. Before this, tg-cli labelled `config set` as
  changing Telegram.

## 0.14.0 — 01.10.2026

### Added

- **Shared settings for checking docs**: `@wirecat/cli-core/cspell` (spelling in English, British
  English and Russian, with the shared word list; code and links are not checked),
  `config/rumdl.toml` (Markdown form) and `config/vale/` (prose: filler words and long sentences in
  both languages, and tg's tone). A repository installs the tools itself — [README](README.md#shared-tooling).
- **`cli-dev docs-check --pages`** also checks `docs/` against `docs/meta.json`, the docs portal's
  page structure.

## 0.13.0 — 01.10.2026

### Added

- **`skillCommand(app, skill, environment, more)`**: `more` names skills a library ships for every CLI
  built on it, and `skill show <name>` prints one, with `{{command}}` turned into the CLI's command.
  cli-messaging ships one for linking conversations. They are printed, never installed — two CLIs
  would install the same name. Without `more`, `skill show` takes no argument, as before.
- **The shared pre-push hook runs `parity:check` after `typecheck`**, when the project has that
  script. tg-cli and max-cli check their commands and pages against cli-messaging's parity manifest
  before a push instead of a minute later in CI. A project without the script sees no change. Why in
  one command: the check builds into the same `dist/` that typecheck writes, and two `tsc` runs side
  by side race on its state file.

## 0.12.0 — 01.10.2026

### Changed — may break callers

- **`commandsPage` writes what tg-cli's own copy of it already did**: each description ends as a
  sentence, the allowed values follow it ("One of: `new`, `old`."), an argument shows its default
  as an option does, and a `~` is escaped — `~~struck~~` in a description struck out the rest of
  the row. `CommandsPageLabels` gains `oneOf` (`COMMANDS_PAGE_LABELS` has it in both languages).
  What to watch for: a regenerated `commands.md` changes on almost every row; a caller with its
  own labels adds `oneOf`.

## 0.11.0 — 01.10.2026

### Added

- **Shared configuration a CLI extends instead of copying.** `@wirecat/cli-core/tsconfig.base.json`
  (compiler options), `/tsconfig.test.json` and `/tsconfig.scripts.json` (the no-emit overlays for
  tests and `scripts/`), `/biome` (formatter, linter, the `scripts/` console rule) and
  `config/lefthook.yml` (the git hooks). Paths, file lists and import rules stay in each repository.
  What to watch for: in lefthook, the extended file overrides your own `lefthook.yml`, not the other
  way round. How to adopt each: [README](README.md#shared-tooling).
- **`cli-dev`, a command for the development scripts every CLI carried a copy of:** `slow-tests`,
  `next-version`, `version`, `docs-check` and `test-matrix`. Each prints what the script it replaces
  printed; the test matrix page names `cli-dev` in its first line, so a repository regenerates and
  commits that page once when it switches.
- **`.github/workflows/node-ci.yml`, a reusable workflow:** install, lint, typecheck, test with
  coverage, build, the extra checks a repository passes in, the Bun run and a gitleaks scan of the
  whole history.

## 0.10.0 — 01.10.2026

### Added

- **`@wirecat/cli-core/skill` installs a CLI's SKILL.md and tells agents when to.** `skillCommand`
  is the `skill` command, moved down from cli-messaging, with a new `install [--for claude|agents|all]`
  that writes the file to `~/.claude/skills/<appName>/` and `~/.agents/skills/<appName>/` and records
  the CLI's version as `metadata.version` in its frontmatter — the Agent Skills specification has no
  top-level `version`. It refuses a SKILL.md whose `name` differs from `<appName>`, the directory it
  writes to, which the specification requires to match. `skillHint` is a once-a-day line for an agent whose copy is
  missing or older than the CLI; `skillResource` serves the file to an MCP client as `<command>://skill`.
  An agent used to learn of the skill only by reading `--help`.
  What to watch for: `skillCommand` takes a third argument, the host's renderer, streams and `env`;
  it imports Commander at run time, so a CLI using `/skill` needs Commander installed, as all four do.
- **The update state file keeps a second field, `skillHintAt`,** and `writeUpdateState` now merges
  into the file as it is when written, instead of replacing it, so the two daily notices do not erase
  each other. It accepts a partial state; `readNoticeState` reads the file whether or not npm was asked.
- **`commandsPage` in `@wirecat/cli-core/commands` writes a CLI's whole `docs/commands.md`** from
  the command tree: every command at any depth, its usage, arguments and options with defaults, and
  the exit codes. The table labels come in English and Russian (`COMMANDS_PAGE_LABELS`); the CLI
  passes its own title, introduction and closing words. It is max-cli's generator, moved here so
  tg-cli gets the same page from the same code; max-cli's page comes out byte for byte the same.
- **`structureProblems` in `@wirecat/cli-core/release` checks a docs folder against its
  `meta.json`**, the sidebar the docs portal reads: every listed page exists, every page is listed
  once, the required pages are there (`REQUIRED_PAGES`), `meta.json` holds only Fumadocs' keys,
  and each page has exactly one `# ` heading, first. `README.md` in the folder is left out — it is
  the contributors' index.

### Fixed

- **`Credentials.write` refuses to replace a credentials file it cannot parse.** It used to read a
  broken file as empty, and the next write replaced it, losing every other secret stored in it. Now
  it throws a `CliError` with code `configuration_error` that names the file and never quotes it.
  `read` still treats such a file as holding nothing, and `remove` leaves it alone.
  What to watch for: `write` can now throw when the keyring is unavailable and the file is broken —
  the user fixes the file or moves it aside. An empty file counts as broken.
- **A generated Valibot schema accepts a 64-bit integer enum.** The values are matched as the
  decimal strings a 64-bit integer becomes, as the generated type already said; before, no input
  passed.
- **Generation stops, naming the schema, when an `allOf` reaches its own schema**, directly or
  through others. It used to overflow the stack.

## 0.9.0 — 30.09.2026

### Added

- **`@wirecat/cli-core/release` holds the release checks that max-cli and tg-cli share.** A runner,
  `releaseCheck`, that runs every check and prints one `ok` or `FAIL` line each, and the checks a
  program can decide: a command that must exit 0, the version not yet on npm, the package contents,
  the changelog's shape, links and anchors in the documents, and the version in `package.json` and
  `src/version.ts` in step. Until now each CLI kept its own copy, and the copies had drifted apart.
  Each caller passes its own changelog headings, id prefixes and user pages.

## 0.8.0 — 27.09.2026

### Added

- **`@wirecat/cli-core/codegen` generates an API catalog from an official description, at build
  time.** It reads a format-neutral `ApiModel` — each operation with an `http` or `rpc` binding, an
  effect (`read`, `write`, `destructive`) and how far its source can be trusted — and writes
  TypeScript types, Valibot schemas, an operation manifest and a coverage page. `writeArtifacts`
  writes them, or with `check` only reports which are stale.
  Why: max-cli's bot commands are generated from the MAX Bot API description, and the same machinery
  serves any CLI that has such a description.
  What to watch for: generation stops, naming the problem, on colliding names, an operation not
  classified as a read or a write, an override that matches nothing, an unknown reference or a
  construct it cannot express — it never drops an operation or falls back to `any`. No parser ships:
  the OpenAPI or Postman adapter lives in the CLI that owns the source.
- **`@wirecat/cli-core/codegen/runtime`**, the few number helpers the generated schemas import at run
  time. A 64-bit integer comes out as its exact decimal string from a `lossless-json` number; any
  other integer that does not fit a JS number fails instead of rounding.
  What to watch for: the schemas decode, they do not encode — validate a request with the schema,
  then send the original lossless value.
