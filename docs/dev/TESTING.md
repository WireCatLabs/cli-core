# Testing

```sh
pnpm lint            # biome
pnpm typecheck       # the package, then the tests, then scripts/
pnpm test            # vitest
pnpm test:coverage   # the same, with the floor below; CI runs this one
pnpm docs:check      # every relative link and anchor in every .md, and the changelog's shape
pnpm build
pnpm smoke:bun       # the real exports, executed under Bun
pnpm test:slow       # the 20 slowest tests and the 10 slowest files
```

CI runs all but the last, plus a secret scan over the whole history —
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), which calls the same reusable
[`node-ci.yml`](../../.github/workflows/node-ci.yml) the other CLIs call.

## The tests are typechecked

`tsconfig.json` excludes the tests, because it builds `dist/`. `tsconfig.test.json` checks them with
`noEmit`, and `tsconfig.scripts.json` checks `scripts/`. Both add the shared overlays in
[`config/`](../../config) to `tsconfig.json`.

⚠ Both overlays carry `"exclude": []`, and that line is the whole point: `extends` inherits `exclude`, so
without it the test config still excludes every test file and passes having checked nothing
(max-cli learned this — [its TESTING.md](https://github.com/WireCatLabs/max-cli/blob/main/docs/dev/TESTING.md#the-rule-a-skip-is-not-a-pass)).
Checked on 2026-09-29 by putting a type error into a test and watching `pnpm typecheck` fail.

## No test reaches the real machine

[`test/sandbox.ts`](../../test/sandbox.ts) is a vitest `setupFiles` entry, so it holds for every test
file, including the next one:

- **`TMPDIR` points into a directory of its own, removed when the file is done.** The config,
  credential, logging and update tests make directories with `mkdtempSync(join(tmpdir(), …))` and
  never removed them; one run left 34 in `/tmp`. Now it leaves none (checked 2026-09-29).
- **`@napi-rs/keyring` is replaced by one that throws.** Every test passes `memoryKeyring()`, but
  `Credentials` without a `keyring` falls back to the real keychain — the owner's, where max-cli's
  token lives. `keyring.ts` loads the module through `createRequire`, which `vi.mock` does not reach,
  so the stand-in goes into the require cache. `src/keyring.test.ts` asserts that `systemKeyring`
  throws, and fails without the sandbox — checked once by running it with `--config /dev/null`, which
  does a real keychain read of an entry that does not exist (and can block on a locked keyring's
  prompt). Keep `get` first in that test: without the sandbox it fails there, before `set` and
  `delete` can write anything.

No `*_CONFIG_DIR` is set: cli-core has no app name of its own, and every test that resolves paths
passes `env` explicitly.

## No test waits for real

The suite takes about half a second. Waits go through an injected `SleepLike`, and `fakeClock()`
from `/testing` records them without waiting. The longest real waits are 20 ms in
`src/logging.test.ts` (a Pino destination reporting its open error) and the child process that
`runUpdate`'s test starts. A new wait gets the injected sleep, never a longer test timeout.

## Coverage has a floor

`vitest.config.ts` holds it: lines 94 %, statements 92 %, functions 90 %, branches 81 % over `src/`,
and **every file at least 50 % of its lines**. The numbers sit just under what the suite reached on
2026-09-29 (94.6 / 92.6 / 91.2 / 82.5). Raise them when coverage rises; never lower them to let a
change through — write the test. Nothing is excluded but the tests themselves; the report is in
`coverage/index.html`.

## Bun

`bun test` cannot run the vitest suite, so [`scripts/smoke.ts`](../../scripts/smoke.ts) runs the real
exports with plain assertions under Bun. A new entry point gets a line there.
