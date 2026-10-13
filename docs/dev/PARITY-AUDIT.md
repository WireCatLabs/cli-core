# Detailed parity audit

The manifest guard checks declared expectations and exceptions. The detailed audit measures the
actual CLI and MCP contracts directly, gathers implementation evidence, and runs fresh isolated
checks. It does not claim semantic equivalence from matching names or high coverage.

## One run

Use an isolated cli-core worktree on the desired shared commit:

```sh
pnpm install --frozen-lockfile --prefer-offline
pnpm parity:audit --fresh --deep --output /tmp/parity-report-new
```

The runner clones and builds each consumer's main, pins its commit, and captures discovery/MCP in
empty homes. It runs full coverage, available lint/typecheck/docs/dist/Bun gates, argv matrices,
and the same documented synthetic local search/read fixture through both consumers under Node and
Bun. Queries execute through the actual CLI, a consumer MCP stdio subprocess, and installed SDK
services; ordered locators, query metadata, coverage and structured error reasons are compared.
Scope, bounds, context, file-text write-back and permission checks use disposable synthetic accounts.
Network guards refuse connections, including swallowed failures. No real account, credentials,
installed user binary or model/provider call is used.

The output directory must not already exist. The existing `pnpm parity:audit --fresh` surface-only
stdout interface remains available. For auditor development, both `--max <isolated-built-checkout>`
and `--tg <isolated-built-checkout>` replace fresh clones. Do not use another session's checkout.

`--skip-checks` explicitly omits suites/gates/matrices; artifacts mark them `not-run`. This limited
mode still captures commands/MCP/source and exercises the synthetic fixture. Do not cite it as
fresh test coverage or a complete functional audit.

## Artifacts

- `report.md`: measured review draft, snapshots/pins, direct differences, failures and limits.
- `commands.md`: every command/group, argument, short/long option, default/choices and argv state.
- `mcp.md`: complete schemas/annotations/output declarations and default/send/all-flags/configured
  exposure. Configured mode reads source-declared opt-in groups; all allow flags alone may not
  expose every tool. Failed capture is distinct from an empty tool list.
- `functions.md` / `sources.md`: mounting/import/local registration/service-call candidates and
  source anchors. Dynamic/aliased bindings remain unresolved, not inferred shared implementations.
- `search.md`: query versions/fields/operators/budgets exported by each consumer's pinned package.
- `scenarios.md`: positive/negative search recipes, explicit/default language and bounded offline
  read/diagnostic outcomes, behavioural checks and both runtimes. Only temporary store paths, free disk and index build timestamps are
  excluded from store-check comparison; scenario results and search ids/error reasons are kept.
- `tests.md`: every test file and skip, fresh line/branch/function coverage, exact coverage config,
  gate results/logs and argv exceptions. Consumer coverage does not include dependency sources.
- `surface.md`: the existing manifest/pages/help/release-tooling measurements.
- `evidence.json`: full machine data, snapshots, differences, errors and retained directories.

Nonzero exit means a requested capture/check/scenario failed. Evidence and logs remain for review.
A successful exit means the requested checks completed; it does not mean every difference has been
resolved or that live operation was verified. A skipped-check run can exit successfully while its
bundle remains explicitly incomplete. Main moving during a run is recorded; captured snapshots
are never silently relabelled as the newer commit.

## Interpretation and limits

The MAX parity skill adds the human review: each functional group's CLI/MCP → service → port →
adapter route, protocol justification, permissions/results, tested/untested scenarios, current
owners and next actions. The source scanner collects lexical candidates, not an AST call graph.
An imported shared factory can still use overrides or different descriptors; a local wrapper can
bind the same service. Keep unresolved routes explicit.

Structural comparison preserves positional argument ordering, aliases/defaults, schema bounds,
additional properties and annotations. Required/enum/choice sets ignore order, prose is separate.
No output schema means output validation is unknown, not proof that responses agree. Planned
manifest rows and opt-in visibility are not implementation absence or passing behaviour tests.

The synthetic fixture covers local personal archive queries/reads and words-only conversation fallback.
Bot legacy search, semantic model execution,
provider name filters and future remote search are separate workflows. Checked-in reference
fixtures do not mean Java harnesses, benchmarks, real models or all operator/value combinations
ran in this audit. Live accounts, delivery/read acknowledgements, OS services/browser auth and
self-upgrade require their own explicitly authorized checks.

Keep artifacts on the relevant cleanup list; do not delete them during the task. Repeated mechanical
checks should be added to `src/parity` or `scripts/parity`, with regression tests for their observable
failure modes.
