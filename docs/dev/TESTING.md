# Testing

```sh
pnpm lint
pnpm typecheck      # the package, then the tests (tsconfig.test.json)
pnpm test           # vitest
pnpm test:coverage  # CI runs this; the report is in coverage/index.html
pnpm docs:check     # every relative link and anchor, and the changelog's shape
pnpm test:slow      # the 20 slowest tests and the 10 slowest files
pnpm smoke:bun      # the SQLite seam, the store and run records, executed under Bun
```

CI runs all of them except `test:slow`, plus `pnpm build` and a secret scan — [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), through cli-base's shared `node-ci.yml`.

## No test touches the owner's store

⚠ `src/testing/sandbox.ts` runs before every test file (vitest `setupFiles`) and points
`MESSAGING_STORE`, the `MESSAGING_*` directories and the test apps' `APP_`, `CHAT_` and `TG_`
directories at a temporary directory. The store is the owner's system of record and migrations are
forward-only: a test that fell back to the default path would migrate the real file, and nothing
undoes that. A test that defines a new app prefix adds it to the sandbox.

## Coverage has a floor

`vitest.config.ts` holds it: lines 92 %, statements 90 %, functions 89 %, branches 77 % over `src/`,
and **every file at least 50 % of its lines**. The numbers sit just under what the suite reached on
2026-09-29 (93.1 / 91.6 / 90.0 / 78.6). Raise them when coverage rises; never lower them to let a
change through — write the test.

Left out: the Bun driver, since `bun:sqlite` does not exist under Node and `pnpm smoke:bun` runs it.
Types-only files have no code to count.

## No test waits for real

A unit test takes milliseconds; one that takes a round second is sleeping in the code under test,
and on a slow CI runner a few of those cross vitest's 5 s limit (max-cli
[`TESTING.md`](https://github.com/WireCatLabs/max-cli/blob/main/docs/dev/TESTING.md#no-test-waits-for-real)).
On 2026-09-29 the slowest test here took 57 ms. The waits that exist are reached without sleeping:

- `messages sync --pause` is the pause between pages; a test passes `--pause 1ms`. A short "wait N
  seconds" from the provider is slept, so a test's fake asks for a few milliseconds.
- The MCP session takes `idleMs`, `maxAgeMs` and `now` (`src/mcp/session.ts`); a test hands in its
  own clock.
- `--timeout` is a setting a test sets short.

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
