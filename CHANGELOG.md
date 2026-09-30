# Changelog

Notable changes to `@leemour/cli-core`, one section per version, newest first. Versions follow
[semantic versioning](https://semver.org/); before `1.0.0` a minor release may change the API.
Versions before 0.8.0 are in the [git tags](https://github.com/leemour/cli-core/tags).

Every entry says what changed as a caller sees it, why, and what to watch for — the rules are
[`docs/dev/CONVENTIONS.md`](docs/dev/CONVENTIONS.md#the-changelog).

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
