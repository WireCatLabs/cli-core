# Merge cli-tasks and cli-meetings into cli-messaging

Status: plan, not started. Owner's call (2026-10-11): fold the shared layers into cli-messaging and keep
modules apart with lint rules, not with packages. Whether cli-core folds in too is still open (see
[cli-core](#cli-core-stays-out-unless-the-owner-says-otherwise)).

## Why

A change to meetings reaches an app through three repositories: release `cli-meetings`, then
`cli-messaging` (which implements `MeetingStore` and depends on it), then bump `zoom-cli`. Tasks go the
same way. The split buys nothing a folder cannot: cli-tasks is 213 lines of source, cli-meetings 2,350,
against cli-messaging's 76,741, and every app already depends on cli-messaging (zoom-cli too, on `main`).
The rule that kept them apart, "cli-messaging depends on this package, never the other way round",
becomes a lint rule.

## Target layout

```
src/tasks/      ← cli-tasks src/ (model, service, store port, testing/)
src/meetings/   ← cli-meetings src/ (model, vtt, source and store ports, pull, import, cli/, mcp/, testing/)
```

A move, not a rewrite: file names and exports stay as they are, imports of `@wirecat/cli-tasks` and
`@wirecat/cli-meetings` inside cli-messaging become relative.

| Old import | New import |
|---|---|
| `@wirecat/cli-tasks` | `@wirecat/cli-messaging/tasks` |
| `@wirecat/cli-tasks/testing` | `@wirecat/cli-messaging/tasks/testing` |
| `@wirecat/cli-meetings` | `@wirecat/cli-messaging/meetings` |
| `@wirecat/cli-meetings/cli` | `@wirecat/cli-messaging/meetings/cli` |
| `@wirecat/cli-meetings/mcp` | `@wirecat/cli-messaging/meetings/mcp` |
| `@wirecat/cli-meetings/testing` | `@wirecat/cli-messaging/meetings/testing` |

## Boundaries

What the separate packages enforced, now in `biome.json` as overrides per folder:

- `src/tasks/**` and `src/meetings/**` import only `@wirecat/cli-core`, `commander` and each other's
  entry point. Not the store, not `node:fs`, not SQLite, not Drizzle, not any provider library.
- Nothing outside `src/meetings/` imports a file inside it except its entry points (`index.ts`, `cli/`,
  `mcp/`, `testing/`); the same for `src/tasks/`.
- The `node:fs` and SQLite bans cli-meetings has today become bans on those two folders only:
  `src/store/` needs them.

Biome's `noRestrictedImports` is measured on package names (cli-meetings uses it). Whether its patterns
match relative specifiers such as `../store/store.js` is **not verified**. The first step of phase 1 is
a deliberate violating import that `pnpm lint` must reject. If biome cannot express it, the fallback is
dependency-cruiser with the same rules, run in `ci:quick`.

## Phases

Each phase is one PR in cli-messaging, released before the next starts.

**Phase 1 — tasks.**
1. Boundary rule first, proven by the violating import above.
2. `git subtree add --prefix=src/tasks` from cli-tasks `main`, then move files into place. Subtree keeps
   cli-tasks' 17 commits in `git log` with no extra tool; a plain copy would lose them.
3. Rewrite the 10 source files and 6 tests that import `@wirecat/cli-tasks`; drop the dependency.
4. Add the `./tasks` and `./tasks/testing` exports; tests, `docs:check`, CHANGELOG line under
   "Changed — may break callers" naming the new import paths.
5. cli-tasks has an open PR (#6); merge or close it before the subtree.

**Phase 2 — meetings.**
1. Freeze cli-meetings: no merges after the subtree commit. Announce in [#849](https://github.com/WireCatLabs/cli-messaging/issues/849) (another session works on
   meetings in cli-messaging) and pick a quiet window.
2. Subtree cli-meetings `main` into `src/meetings/`; rewrite 10 source files and 12 tests; drop the
   dependency; add the four `./meetings*` exports.
3. Move the cli-meetings docs that still hold (`ARCHITECTURE`, the port descriptions) into
   `docs/dev/ADAPTERS.md` or a `docs/dev/MEETINGS.md`; the rest goes with the archived repo.
4. zoom-cli is the only app that imports cli-meetings (`.`, `/cli`, `/testing`): one PR there after the
   release. tg, max, memo and drive import neither package.

**Phase 3 — shims and retirement (owner).**
1. Last release of `@wirecat/cli-tasks` and `@wirecat/cli-meetings`: each re-exports from the matching
   cli-messaging subpath, with a README line pointing there. One version, then
   `npm deprecate` on both names.
2. Archive the two GitHub repositories; their local checkouts and worktrees go to CLEANUP.md.

## cli-core stays out, unless the owner says otherwise

cli-core is not a thin layer like the other two:

- `@wirecat/cli-testing` depends on cli-core alone.
- cli-core ships the shared tooling every repository builds with: `./biome`, `./tsconfig.*`,
  `./lefthook.yml`, `./release`, plus the command framework (`./commands`, `./mcp`, `./http`,
  `./update`, `./completion`).
- cli-messaging carries native and heavy dependencies (`sherpa-onnx`, `@resvg/resvg-js`, `echarts`,
  `@huggingface/tokenizers`). Folded in, cli-core would make the test toolkit and any future CLI that
  has nothing to do with messaging install them, and a change to the shared lint config would ship as a
  cli-messaging release.
- cli-core is not in the chain that hurts: 79 commits in its life against cli-messaging's 1,208.

So the plan stops at two shared packages: cli-core (framework and tooling) and cli-messaging (everything
the messenger CLIs share). Folding cli-core in later is the same three phases.

## Connector authors

No separate SDK package. A connector author runs the real CLI and tests against the real store, so a
light package saves them nothing. The public surface is a documented subpath instead:
`@wirecat/cli-messaging/sdk` re-exports the ports (`MessengerAdapter`, `MeetingSource`, `MeetingStore`,
the task store), the models and the errors. Added in phase 2, when all ports live here.

## Done when

- cli-messaging has no `@wirecat/cli-tasks` or `@wirecat/cli-meetings` dependency.
- The boundary rules reject a forbidden import in CI.
- zoom-cli builds on the new paths; the old package names are deprecated on npm.
