# Testing

```sh
pnpm lint
pnpm typecheck      # the package, then the tests (tsconfig.test.json)
pnpm test           # vitest
pnpm test:coverage  # the report is in coverage/index.html
pnpm docs:check     # every relative link and anchor, and the changelog's shape
pnpm test:slow      # the 20 slowest tests and the 10 slowest files
pnpm smoke:bun      # the SQLite seam, the store and run records, executed under Bun
```

A pull request runs the fast checks ([`.github/workflows/standards.yml`](../../.github/workflows/standards.yml)):
`pnpm standards:check`, `pnpm lint`, `pnpm docs:lint`, `pnpm ci:quick` (the typecheck and the command lint) and a
secret scan of the new commits, beside the changelog guard. It also runs full validation
([`.github/workflows/pr.yml`](../../.github/workflows/pr.yml), which calls
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) and through it cli-base's shared `node-ci.yml`): all of
the commands above except `test:slow`, with the coverage floor, plus `pnpm build`, the schema and dist checks, old
Node, the SQLite restart and parity, which builds tg-cli, max-cli, whatsapp-cli and cli-template against the branch
([WC-CI-5](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/ci.md#wc-ci-5--run-the-full-linux-validation-on-every-pull-request-and-keep-platform-suites-out)).
On a pull request parity builds each CLI at the branch with the same name as the pull request's branch when
that CLI has one, and at its `main` otherwise, so a change paired with adoption branches in the CLIs can pass
before they merge ([`scripts/parity/app-ref.sh`](../../scripts/parity/app-ref.sh)).
A pull request that changes only `CHANGELOG.md` and `package.json`'s version against a `main` whose pull request
passed every required check on the same tree (bin/release's fold and version pull requests) runs `pnpm docs:check`
and the changelog shape test instead, and reports the other required checks as passed, saying why
([`scripts/ci-unchanged.sh`](../../scripts/ci-unchanged.sh), [`scripts/ci-fingerprint.sh`](../../scripts/ci-fingerprint.sh)).
The push to `main` that follows runs the full validation. The step
`Build <cli>-cli <ref> against this cli-core` names the ref it built. A push to `main` and the monthly run build
each CLI's `main`; a release builds `main` or the branch `bin/release --app-ref` names.
The same full validation runs again on each push to `main`, in the release and in the monthly run.

## No test touches the owner's store, keyring or network

⚠ vitest's `setupFiles` runs cli-base's shared setup (`@wirecat/cli-base/testing/setup`) before every test
file. It points the temporary folder, the home folder and every `<PREFIX>_CONFIG_DIR`, `_STATE_DIR`,
`_CACHE_DIR` and `MESSAGING_STORE` at a fresh directory
([WC-TEST-1](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/testing.md#wc-test-1--point-every-path-a-test-could-write-at-a-temporary-directory)), replaces the
OS keyring with one that throws
([WC-TEST-2](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/testing.md#wc-test-2--no-test-reaches-the-real-keyring)), and refuses every connection that is not
to localhost ([WC-TEST-3](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/testing.md#wc-test-3--no-test-contacts-a-provider-or-the-network)). The store is the
owner's system of record and migrations are forward-only: a test that reached the real file would migrate
it, and nothing undoes that.

A test that stores a key passes `keyring: memoryKeyring()` (from `@wirecat/cli-base/testing`) to `run()`,
`provide()`, the MCP tool defaults or the function it calls. The throwing keyring does not fail the test on
its own — `Credentials` falls back to a file and prints `a test reached the real OS keyring` on stderr — so
a full run should print that line zero times.

`src/testing/sandbox.ts` runs after it and holds only what is cli-core's own: the test apps' profile and
pace, and the agent and model variables an agent's shell would leak in. A test that defines a new app prefix
adds it there.

`src/testing/fresh-store.ts` runs last: a store opened where no file is yet starts from a copy of one migrated
once per test file, since migrating an empty store costs 40–55 ms and a run opens about 1,900 of them. Everything
else in opening still runs on the copy. A test that needs the migrations themselves to run opens a file at an older
version, or calls `migrate` itself.

## Coverage has a floor

`vitest.config.ts` holds it: lines 92 %, statements 90 %, functions 89 %, branches 77 % over `src/`,
and **every file at least 50 % of its lines**. The numbers sit just under what the suite reached on
2026-09-29 (93.1 / 91.6 / 90.0 / 78.6). Raise them when coverage rises; never lower them to let a
change through — write the test.

Left out: the Bun driver, since `bun:sqlite` does not exist under Node and `pnpm smoke:bun` runs it.
Types-only files have no code to count.

## No test waits for real

A unit test takes milliseconds; one that takes a round second is sleeping in the code under test,
and on a slow CI runner a few of those cross the test time limit — 15 s here (`testTimeout` in
`vitest.config.ts`), raised from vitest's 5 s because several suites share one machine (max-cli
[`TESTING.md`](https://github.com/WireCatLabs/max-cli/blob/main/docs/dev/TESTING.md#no-test-waits-for-real)).
On 2026-09-29 the slowest test here took 57 ms. The waits that exist are reached without sleeping:

- `messages sync --pause` is the pause between pages; a test passes `--pause 1ms`. A short "wait N
  seconds" from the provider is slept, so a test's fake asks for a few milliseconds.
- The MCP session takes `idleMs`, `maxAgeMs` and `now` (`src/mcp/session.ts`); a test hands in its
  own clock.
- `--timeout` is a setting a test sets short.
- A connection's close waits 5 s on its saves and passive listens, and chat re-keys pause between
  passes. A test sets `closeWaitMs` and `rekeyPacing` in its run environment, as it sets
  `storeLockWaitMs` for `store restore` and `store reset`.

A new wait in the code gets a seam like these, never a longer timeout in the test.

## Live checks

The suites never contact a messenger. [`bin/live-tasks`](../../bin/live-tasks) `tg|max`, run by the owner
from a terminal, checks the task rules on a real test chat: the second account must be a different account, and
joins the chat by its invite link if it is not a member; then it asks, the owner's `review` opens a task, the
owner's reply closes it, and both messages are deleted by their own senders. The chat and both profiles are in
`.live/cast.env`, which git ignores; no profile is assumed. The script prints no id and no text. It came from
cli-tasks, retired 2026-10-11.

## Parity evidence

[Detailed parity audit](PARITY-AUDIT.md) runs fresh isolated consumer checks and records every schema/source/coverage difference. `scripts/parity/evidence.test.ts` checks MCP framing, timeout/exit/errors and mixed mounting evidence; `src/parity/deep.test.ts` checks direct structural differences and exemptions.

## Command lint

`src/cli/command-lint.test.ts` runs `cli-dev lint` over a synthetic CLI that mounts every shared command
(`src/testing/shared-program.ts`), in every pull request through `ci:quick`. What is not fixed yet is listed in
`lint/baseline/`, which only shrinks: fix a violation, delete its line. A new shared command goes into the synthetic
CLI.

## Agent guidance and task evaluations

The `skill-validation` export reads YAML frontmatter, checks portable names/description/metadata,
local references and literal command paths against a supplied program. Consumers validate the
source skill and the version prepared for installation against their own command discovery. It
never executes a skill example or opens a messenger session.

`evaluateAgent` runs an injected policy through a synthetic CLI definition and scores task-specific
checks. It reports correctness, call counts and serialized output bytes, excluding arguments,
message bodies and policy reasoning from persisted metrics. The deterministic baseline covers
scoped schema discovery, ambiguity, pagination, validation recovery, compact output and refusing
a replay of an unknown write. Its six passing tasks validate the harness; they do not measure a
language model. Real agent passes must be labelled separately with the skill/build and task set,
and use the same isolated synthetic provider without owner accounts or external credentials.

The independent agent pass records the source skill,
task outcomes, calls, bytes and limitations of the first measured synthetic run.

## Minimum supported Node mail writes

The old-node job retains its Node 22.15 refusal check, then runs
[`scripts/node22-mail.mjs`](../../scripts/node22-mail.mjs) on supported Node 22.16. The public-store
fixture checks saving/deleting/restoring thread counts, read/star changes and no-ops, timestamps and
account isolation. It refuses an existing database path. This protects the Node22 SQLite binding
boundary that a Node 24-only mail suite cannot establish. Use a new temporary path when running it
locally; no owner store or credentials are needed.
