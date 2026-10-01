# Changelog

Notable changes to `@leemour/cli-core`, one section per version, newest first. Versions follow
[semantic versioning](https://semver.org/); before `1.0.0` a minor release may change the API.
Versions before 0.8.0 are in the [git tags](https://github.com/leemour/cli-core/tags).

Every entry says what changed as a caller sees it, why, and what to watch for — the rules are
[`docs/dev/CONVENTIONS.md`](docs/dev/CONVENTIONS.md#the-changelog).

## Unreleased

### Added

- **`@leemour/cli-core/skill` installs a CLI's SKILL.md and tells agents when to.** `skillCommand`
  is the `skill` command, moved down from cli-messaging, with a new `install [--for claude|agents|all]`
  that writes the file to `~/.claude/skills/<appName>/` and `~/.agents/skills/<appName>/` and records
  the CLI's version in its frontmatter. `skillHint` is a once-a-day line for an agent whose copy is
  missing or older than the CLI; `skillResource` serves the file to an MCP client as `<command>://skill`.
  An agent used to learn of the skill only by reading `--help`.
  What to watch for: `skillCommand` takes a third argument, the host's renderer, streams and `env`;
  it imports Commander at run time, so a CLI using `/skill` needs Commander installed, as all four do.
- **The update state file keeps a second field, `skillHintAt`,** and `writeUpdateState` now merges
  into the file as it is when written, instead of replacing it, so the two daily notices do not erase
  each other. It accepts a partial state; `readNoticeState` reads the file whether or not npm was asked.

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

- **`@leemour/cli-core/release` holds the release checks that max-cli and tg-cli share.** A runner,
  `releaseCheck`, that runs every check and prints one `ok` or `FAIL` line each, and the checks a
  program can decide: a command that must exit 0, the version not yet on npm, the package contents,
  the changelog's shape, links and anchors in the documents, and the version in `package.json` and
  `src/version.ts` in step. Until now each CLI kept its own copy, and the copies had drifted apart.
  Each caller passes its own changelog headings, id prefixes and user pages.

## 0.8.0 — 27.09.2026

### Added

- **`@leemour/cli-core/codegen` generates an API catalog from an official description, at build
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
- **`@leemour/cli-core/codegen/runtime`**, the few number helpers the generated schemas import at run
  time. A 64-bit integer comes out as its exact decimal string from a `lossless-json` number; any
  other integer that does not fit a JS number fails instead of rounding.
  What to watch for: the schemas decode, they do not encode — validate a request with the schema,
  then send the original lossless value.
