# @leemour/cli-core

The parts every command line tool needs and nobody enjoys writing twice: the two output streams,
a renderer for people and for machines, a closed error model with stable exit codes, the OS
keyring behind a testable seam, and injectable clocks.

Extracted from [`brazecli`](https://github.com/leemour/brazecli), where each piece earned its
shape, and shared with [`max-cli`](https://github.com/leemour/max-cli).

Published on npm and used by `max-cli`, `cli-messaging`, `tg-cli` and `brazecli`. What changed in
each version is in [`CHANGELOG.md`](CHANGELOG.md); how the package is put together and released is in
[`docs/dev/`](docs/dev/ARCHITECTURE.md).

## The rule this package exists to keep

**In a machine mode, stdout carries data and nothing else.** No spinner, no `✓`, no warning, no
ANSI. Diagnostics go to stderr, in every mode including the pretty one. That is the contract a
script or an agent depends on, and `captureStreams` exists so a test can prove nothing leaked
across.

```ts
import { captureStreams, createRenderer } from "@leemour/cli-core"

const streams = captureStreams()
createRenderer({ format: "json", color: false, streams }).result({ chats: 2 })

streams.stdout // ['{"chats":2}']
streams.stderr // []
```

## What is in it

| | |
|---|---|
| `streams` | the stdout/stderr split, and the capture used to test it |
| `renderer` · `pretty` | `pretty` / `json` / `jsonl`; tables for lists, labelled lines for objects; `quiet` keeps only failures on stderr |
| `errors` · `exit-codes` | 14 closed error codes, one exit number each, so a script can branch on `$?` |
| `keyring` | `KeyringStore` with the system, memory and deliberately-broken implementations |
| `time` | monotonic and wall clocks, and the one sleep that both timeouts and backoff use |
| `logger` | the four-method interface a host adapts Pino to — this package logs nothing itself |
| `paths` | `env-paths` for config, state and cache, each overridable by environment variable |
| `config` | JSON config loading that names the bad field, and an atomic write that locks the directory down |
| `credentials` | environment → keyring → file, warning once and falling through when the keyring refuses |
| `logging` | a Pino adapter writing JSON lines with secrets redacted by field name; a file that cannot be written is reported to `onError`, never thrown |
| `retry` | full-jitter backoff, and the distinction between "no answer came" and "safe to repeat" |
| `/testing` | `captureStreams`, `memoryKeyring`, `brokenKeyring`, `fakeClock` |
| `/commands` | the command registry: `describeProgram`, `annotate`, `flatten` — see below |
| `/completion` | shell completion over the registry: `suggest`, `formatSuggestions` — see below |
| `/update` | keeping an install current: `installerOf`, `updateCommand`, `latestVersion`, `mayNotify`, `updateNotice`, `runUpdate` — see below |
| `/codegen` | build time: an official API description → types, Valibot schemas, an operation manifest and a coverage page — see below |
| `/release` | release time: `releaseCheck` and the checks it runs — changelog shape, links, package contents, version in step — see below |
| `/skill` | the CLI's SKILL.md for coding agents: `skillCommand` (`show`, `install`), `skillHint`, `skillResource` — see below |

**Nothing in the root export is HTTP.** Status classification, `Retry-After` parsing and the fetch
seam live in `@leemour/cli-core/http`, so a CLI that speaks a socket never depends on a stack it
does not call:

```ts
import { providerWaitMs, statusToCode } from "@leemour/cli-core/http"
```

**The command registry is `@leemour/cli-core/commands`** — the whole command tree as data, like
`rails routes`, for an agent to read instead of `--help` and for generated documentation. It walks
the live [Commander](https://github.com/tj/commander.js) tree, so a command built in a loop from a
catalog appears exactly like a handwritten one; `annotate` adds what the tree cannot say. Commander
is a type here, not a runtime dependency — an optional peer, 15 or newer.

```ts
import { annotate, describeProgram } from "@leemour/cli-core/commands"

annotate(program.command("send"), { mutates: true, examples: ["max messages send 42 hi"] })
annotate(generated, { origin: "generated", operationId: "campaigns.list" })

describeProgram(program) // [{ path: ["send"], usage, origin, mutates, options: [...], commands: [...] }]
```

Each option says whether it `takesValue` and, separately, whether it is `mandatory` — not
Commander's `required`, which means "takes a value when given" — plus its choices, default,
environment variable, the options it `conflicts` with and the values it `implies`.

**Shell completion is `@leemour/cli-core/completion`**, built on the registry. `suggest` takes the
words typed so far and answers what may come next: a command, an action, an option, one of its
values, or an argument's values from a source the CLI hands in — a local cache, never the network,
because a shell calls it on every Tab. `formatSuggestions` writes the answer in the protocol of the
shell scripts [`@bomb.sh/tab`](https://github.com/bombshell-dev/tab) generates, so the CLI prints
those scripts with tab and answers `<cli> complete -- <words>` with this; cli-core itself does not
depend on tab.

```ts
import { formatSuggestions, suggest } from "@leemour/cli-core/completion"

const words = argv.slice(argv.indexOf("--") + 1)
streams.data(formatSuggestions(suggest({ commands, globalOptions, words, sources: { arguments: { chat: chatNames } } })))
```

**Two traps worth knowing before you use the credential store.** The OS keyring is global: an entry
is addressed by service and account and knows nothing about which config directory asked for it, so
a throwaway config directory silently overwrites the real secret unless you pass `isolated: true`.
And a secret should never be handed to a logger in the first place — redaction by field name is the
second line of defence, not the first.

**Everything the environment knows can be passed in**: the clock, the sleep, the keyring, `env`,
`fetch` and the streams. The real ones are only defaults — `Credentials` without a `keyring` uses the
system keychain, `resolvePaths` without `env` reads `process.env`. Passing them is what makes a
timeout test finish instantly and a keyring test incapable of reaching a real keychain.

**Generating an API catalog is `@leemour/cli-core/codegen`**, a build-time tool. It reads a
format-neutral `ApiModel` — operations with a transport binding (`http` method and path, or `rpc`
name), an `effect` (`read`, `write`, `destructive`) and how far the source can be trusted
(`contract`, `example`, `inferred`, `override`) — and writes committed files. It parses no file
format: the adapter from OpenAPI, Postman or anything else lives in the CLI that has that source,
so this adds no dependency. Generation stops, naming the problem, when two operations collide, an
operation is not classified as a read or a write, an override matches nothing, a reference points
nowhere or a construct cannot be expressed; it never drops an operation or falls back to `any`.

```ts
import { generate, manifestGenerator, typesGenerator, valibotGenerator, writeArtifacts } from "@leemour/cli-core/codegen"

const artifacts = generate(model, [typesGenerator({ path }), valibotGenerator({ path, typesImport }), manifestGenerator({ path })], {
  overrides: { answerOnCallback: { effect: "write", reason: "a POST that edits a message" } },
  banner: ["Source: spec/bot/schema.yaml", "Run: pnpm bot:generate"],
})
const stale = writeArtifacts(artifacts, { root, check: process.argv.includes("--check") })
```

The generated schemas import `@leemour/cli-core/codegen/runtime` at run time — a few number
helpers, not the generator. Numbers are expected from a lossless JSON parser (`lossless-json`): a
64-bit integer comes out as its exact decimal string, and any other integer that does not fit a JS
number fails instead of rounding. Objects are loose, so a field the API added later passes through.
Enums and discriminated unions are **strict**: a value or subtype the snapshot does not know fails,
so decode a live stream (updates, webhooks) only where that is what you want.

**The schemas decode; they do not encode.** Their output carries an `int64` as a string, so sending
it back would put a string where the API expects a number. Validate a request with the schema, then
send the original lossless value.

**Keeping an install current is `@leemour/cli-core/update`.** `installerOf(realpath(script))` says
which package manager put the CLI there — pnpm, npm or bun, measured on real installs — and
`updateCommand` gives the argv that updates it; a checkout or `npx` gets none. `latestVersion` asks
npm with a timeout and answers `undefined` on any failure. `mayNotify` says whether a person is at a
terminal to be told: never in JSON, a pipe, `--quiet`, `CI` or with `NO_UPDATE_NOTIFIER`.
`updateNotice` is the whole daily line: it stays silent when `update` or `complete` is anywhere on
the command line, asks npm at most once a day through a state file the CLI names, and returns the
sentence or `undefined` — it never throws. `runUpdate` starts the package manager with its output on
stderr (`spawnPlan` is the Windows `.cmd` rule). Nothing here updates or prints by itself — a CLI
holding somebody's credentials must not change itself unasked.

**A CLI's guide for coding agents is `@leemour/cli-core/skill`.** `skillCommand(app, skillUrl,
environment)` is `<cli> skill show` — SKILL.md on stdout, even into a pipe, or `{ name, content }`
with `--json` — and `<cli> skill install [--for claude|agents|all]`, which writes it to
`~/.claude/skills/<appName>/` and `~/.agents/skills/<appName>/` with the CLI's version as `version:`
in the frontmatter. `environment` is the host's own renderer, streams and `env` for that invocation.
`skillHint` is one line, or `undefined`, for an agent (`AI_AGENT` or `CLAUDECODE` set) with no copy
installed or an older one, at most once a day, through the same state file as `updateNotice`; the
host prints it on stderr. `skillResource` is what an MCP server registers to serve the file as
`<command>://skill`, plus a line for its `instructions` — the SDK stays the host's.

**The release checks are `@leemour/cli-core/release`** — everything about a release that a program
can decide. A check is `{ name, run }`, and `run` returns the problems it found, one line each; an
empty list is a pass. `releaseCheck(checks, { version, log })` runs them all, even after a failure,
prints `ok` or `FAIL` per check and returns how many failed — the caller exits. The checks every CLI
shares: `command(root, "pnpm", "lint")` for anything that passes by exiting 0, `notOnNpm`,
`packContents` against a list of what may ship, `changelogProblems` for the fixed headings and the
dated top section, `docsProblems` for dead links and anchors and the rules of the pages a user reads,
and `versionScript` — the whole of a `version:check` / `version:sync` script. Each CLI passes its
own headings, id prefixes and pages; the checks that belong to one messenger stay in that CLI.

```ts
import { command, notOnNpm, packageVersion, releaseCheck } from "@leemour/cli-core/release"

const version = packageVersion(root)
const failed = releaseCheck(
  [
    { name: "version not on npm", run: notOnNpm(root, "@leemour/tg-cli", version) },
    { name: "lint", run: command(root, "pnpm", "lint") },
  ],
  { version, log: console.log },
)
process.exit(failed === 0 ? 0 : 1)
```

## Where secrets actually go, per platform

The keyring is real on every desktop and absent on most servers, so the fallback is not an edge
case — it is the normal path in CI and containers. Checked against `@napi-rs/keyring` 2.1.0 on
2026-09-19.

| Platform | Backing store | Needs installing |
|---|---|---|
| macOS | Keychain, via the Security framework | nothing — part of the OS |
| Windows | Credential Manager | nothing — part of the OS |
| Linux desktop (GNOME, KDE) | Secret Service over D-Bus — `gnome-keyring`, `kwallet` | nothing on a normal desktop; the keyring must be **unlocked** |
| Linux headless, container, WSL, CI | usually **nothing** — no session bus, no secrets daemon | falls back to a `0600` file, with one warning on stderr |
| FreeBSD | Secret Service, same as Linux | same |

**No compiler is involved.** The package ships prebuilt binaries for twelve platform triples —
macOS arm64/x64, Windows x64/ia32/arm64, Linux x64 and arm64 in both glibc and musl, armv7,
riscv64, FreeBSD x64 — so there is no Rust toolchain and no node-gyp on any mainstream target.
The Linux binary links only against libc: it speaks D-Bus itself rather than through libsecret,
so *libsecret is not a requirement* — a running Secret Service provider is.

Two consequences worth designing for rather than discovering:

- **`auto` is the right default and `file` must stay available.** `credentialStorage: "file"` skips
  the keyring entirely, which is what a container wants and what a locked keyring makes necessary.
- **A locked Linux keyring can block on a prompt** rather than failing. That is the one case the
  fallback does not rescue, and a CLI that hangs looks broken rather than locked.

## Both runtimes

Node 22+ and Bun, and the Bun half is executed rather than assumed:

```sh
pnpm test        # vitest, Node
pnpm smoke:bun   # the same exports, actually run under Bun
pnpm lint
pnpm typecheck
pnpm build
```

The rest of the checks, and what each is for, are in [`docs/dev/TESTING.md`](docs/dev/TESTING.md).

## Releasing

Raise `version` in `package.json` and date the `## Unreleased` section of
[`CHANGELOG.md`](CHANGELOG.md) as that version, through a pull request; merge it, then on `main`:

```sh
bin/release
```

It refuses a dirty tree, a branch other than `main` and a `main` that is not pushed. When npm already
has the version, or a higher one, it commits the next free version to `main` — the next minor for
`x.y.0`, the next patch otherwise — renames the changelog heading to match, and publishes that. Then it starts
[`release.yml`](.github/workflows/release.yml) and follows it. The workflow runs every check,
publishes through npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers/) — no npm
token in GitHub, and npm attaches provenance — and tags `v<version>` only once npm shows the new version.

npm trusts the workflow **by file name**: the package's Trusted Publisher settings on npmjs.com name
`leemour` / `cli-core` / `release.yml`. Rename the file and publishing stops until they are updated.

`bin/release --local` is the fallback: it runs the same checks here and publishes with the npm token
from the keyring (`secret-tool`, service `npm`, account `leemour`) without printing it. The token
must be allowed to write `@leemour/cli-core`, not only `@leemour/max-cli`.

## Licence

MIT.
