# Architecture

**Status (2026-09-29):** describes `@leemour/cli-core` 0.8.0 as built. The consumer versions below
were read from each repository's `package.json` on `origin/main` that day; they move with every release, so check
them again before relying on them.

**Correction 2026-10-01:** it describes 0.9.0, which added `/release`. The consumer pins below were
read again that day.

`cli-core` is the part of a command line tool that is not about any one service: the two output
streams, the renderer, the error model and exit codes, the keyring and credentials, config and
paths, clocks, retry, and — behind their own entry points — HTTP, the command registry, completion,
self-update and code generation. What each export does is the table in the
[README](../../README.md#what-is-in-it); this page is about the seams and how a change travels.

Where each piece came from — and what was deliberately left in `brazecli` — is §4 of max-cli's
architecture proposal ([private repository](https://github.com/leemour/cli-private/blob/main/plans/2026-09-19-architecture.md#4-the-inventory-what-braze-cli-has-and-where-each-piece-goes)).

## Entry points

| Import | Owns | Depends on |
|---|---|---|
| `@leemour/cli-core` | streams, renderer, pretty, errors, exit codes, keyring, credentials, config, paths, logging, retry, time, sanitize | `env-paths`, `pino`, `cli-table3`, `picocolors`; `@napi-rs/keyring` loaded on first use |
| `/http` | status → error code, `Retry-After` and rate-limit parsing, the `fetch` seam | the root's `ErrorCode` and `WallClock` types |
| `/commands` | the command tree as data (`describeProgram`, `annotate`, `flatten`), and the reference page written from it (`commandsPage`) | Commander, as a type only |
| `/completion` | shell completion over that tree | `/commands` types |
| `/update` | which installer put the CLI there, the daily notice, running the update | `config` (the state file), `/http`'s `FetchLike` |
| `/codegen` | build time: `ApiModel` → types, Valibot schemas, manifest, coverage page | nothing at run time |
| `/codegen/runtime` | the number helpers generated schemas import | `valibot` |
| `/release` | release checks a CLI runs before it publishes: `releaseCheck` and the checks it runs (changelog shape, document links, versions in step, package contents) | Node built-ins only |
| `/skill` | the CLI's SKILL.md for agents: the `skill` command, the daily hint, the MCP resource | Commander **at run time** (the only entry point that is), `/update`'s state file, the root's `Renderer` and `Streams` types |
| `/mcp` | local stdio MCP entry setup and a handshake probe | Node child processes; no messenger or MCP SDK dependency |
| `/testing` | `captureStreams`, `memoryKeyring`, `brokenKeyring`, `fakeClock` | the root |

Each is a separate `exports` entry in [`package.json`](../../package.json), built from
`src/<name>/index.ts`. **Everything under `src/` ships in `dist/`**, including `src/testing/` — which
is why the test sandbox lives in [`test/`](../../test/sandbox.ts) and not there.

Two more things ship that are not imports:

- **`cli-dev`**, the `bin` built from [`src/dev/`](../../src/dev/main.ts): the development scripts each
  CLI used to copy. It reads and writes the repository it is run in and never the network.
- **[`config/`](../../config)**: the tsconfig, Biome and lefthook bases a CLI extends, exported as
  `./tsconfig.base.json`, `./tsconfig.test.json`, `./tsconfig.scripts.json`, `./biome` and
  `./lefthook.yml`. cli-core extends them itself, so its own checks exercise them. The reusable CI
  workflow, [`.github/workflows/node-ci.yml`](../../.github/workflows/node-ci.yml), is not in the
  package; a repository calls it from GitHub.

## The two lines this package does not cross

**Nothing in the root export is HTTP**, so a CLI that only speaks a socket never depends on an HTTP
stack. max-cli's personal account is a WebSocket; its bot commands, brazecli and tg-cli import
`/http`. A new helper that reads a status code or a header goes to `/http`.

**The environment is an argument.** Clock, sleep, keyring, `env`, `fetch`, streams — each is a
parameter, with the real one only as the default. That is what lets a timeout test finish instantly
and makes the keyring unreachable from a test ([`TESTING.md`](TESTING.md)). The trap is the defaults:
`new Credentials({...})` without `keyring` is the owner's real keychain, and `resolvePaths` without
`env` reads `process.env`.

**cli-core logs nothing and prints nothing by itself.** It hands a host a `Logger` interface, a Pino
adapter and a renderer; what is written, and where, is the host's call.

## Who consumes it

| Repository | Pins | Subpaths used |
|---|---|---|
| [max-cli](https://github.com/leemour/max-cli) | `0.9.0` | root, `/commands`, `/codegen`, `/codegen/runtime`, `/http`, `/release`, `/update`, `/completion` |
| [cli-messaging](https://github.com/leemour/cli-messaging) | `0.9.0` | root, `/commands`, `/completion`, `/update` |
| [tg-cli](https://github.com/leemour/tg-cli) | `0.9.0` | root, `/commands`, `/http`, `/release`, `/update` |
| [brazecli](https://github.com/leemour/brazecli) | `^0.6.0` | root, `/commands`, `/completion`, `/http`, `/update` |

**Correction 2026-10-01:** the pins above were `0.8.0`, `0.7.0` and `0.7.0` on 2026-09-29, and
max-cli and tg-cli did not list `/release`. brazecli still pins `^0.6.0`.

All four are exact versions in effect: a caret on `0.x` does not cross a minor (`^0.6.0` never picks up
0.7.0). **A release reaches nobody until each consumer bumps its pin.**

⚠ **cli-messaging carries its own copy.** It lists cli-core under `dependencies`, so max-cli, which
pins 0.8.0 while cli-messaging pins 0.7.0, installs both — they are side by side in max-cli's
`node_modules/.pnpm` today. tg-cli pins the same 0.7.0 and gets one. The types still line up
(`CliError` has no private members), but `isCliError()` is an `instanceof` check, so a `CliError` made
by one copy is not recognised by the other. Bump cli-messaging together with the CLIs.

**Correction 2026-10-01:** there is one copy today. cli-messaging, max-cli and tg-cli all pin
0.9.0, and so do the cli-messaging versions the two CLIs pin (0.79.0 and 0.82.0). The rule to bump
them together stands.

## How a change is published and picked up

1. A pull request here, with the `CHANGELOG.md` entry under `## Unreleased` and, when it is ready to
   ship, `version` in `package.json` raised and the heading dated as that version.
2. After merge, `bin/release` on `main` ([README](../../README.md#releasing)). If npm already has the
   number, it takes the next free one and renames the changelog heading with it, then starts
   [`release.yml`](../../.github/workflows/release.yml), which runs every check, publishes through
   npm's trusted publishing and tags `v<version>`.
3. In each consumer, raise the pin in `package.json` and run its suite — cli-messaging first, since
   max-cli and tg-cli also get cli-core through it.
