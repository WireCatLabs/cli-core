# Merge cli-tasks and cli-meetings into cli-messaging

Status: approved 2026-10-11. Phase 1 released in 0.239.0, phase 2 in 0.244.0; phase 3 under way; phase 4 under way.
Owner's calls (2026-10-11): fold cli-tasks and cli-meetings into cli-messaging and keep modules apart with
lint rules, not with packages; cli-core stays a separate package; then rename cli-core → **cli-base** and
cli-messaging → **cli-core** ([Naming](#naming)).

## Why

A change to meetings reaches an app through three repositories: release `cli-meetings`, then
`cli-messaging` (which implements `MeetingStore` and depends on it), then bump `zoom-cli`. Tasks go the
same way. The split buys nothing a folder cannot: cli-tasks is 213 lines of source, cli-meetings 2,350,
against cli-messaging's 76,741, and every app already depends on cli-messaging (zoom-cli too, on `main`).
The rule that kept them apart, "cli-messaging depends on this package, never the other way round",
becomes a lint rule.

## Target layout

```text
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
3. Rewrite the 18 files (counted 2026-10-11) that import `@wirecat/cli-tasks`; drop the dependency.
4. Add the `./tasks` and `./tasks/testing` exports; tests, `docs:check`, CHANGELOG line under
   "Changed — may break callers" naming the new import paths.
5. cli-tasks PR #6 had to land before the subtree: merged 2026-10-11.

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
   `npm deprecate` on both names. Prepared as cli-tasks 0.4.0
   (cli-tasks#28) and cli-meetings 0.5.0
   (cli-meetings#51), with cli-messaging as a peer
   so an app keeps one copy. zoom-cli 0.7.0 is already on the new paths, so the deprecation warns no `zm`
   install.
2. Delete the two GitHub repositories (owner, 2026-10-11: delete, not archive); their local checkouts and
   worktrees go to CLEANUP.md. Their code history is in this repository; their pull requests and tags go
   with them. cli-meetings' roadmap moved to [MEETINGS.md](MEETINGS.md#providers-next) first.

## Why cli-core stays out

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

So the plan stops at two shared packages: the framework and tooling, and everything the messenger CLIs
share. After [Naming](#naming) they are `cli-base` and `cli-core`.

## Connector authors

No separate SDK package and no `/sdk` subpath (owner, 2026-10-11). A connector author runs the real CLI
and tests against the real store, so a light package saves them nothing, and a second path to the same
names would have to be kept in step in every release. The ports, models and contract kits each have one
entry point; [ADAPTERS.md](ADAPTERS.md#where-to-import-from) lists them.

## Naming

The framework becomes `cli-base`, and cli-messaging takes the freed name `cli-core`. Both the GitHub
repository name and the npm name are reused, and each reuse has a trap:

- **GitHub.** Renaming `cli-core` to `cli-base` leaves a redirect from the old name, and GitHub's
  [renaming docs](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)
  say a new repository under the old name ends it: "do not reuse the original name of the renamed
  repository … redirects to the renamed repository will no longer work." Once cli-messaging is renamed
  to `cli-core`, every old link to `WireCatLabs/cli-core` (235 files across the repositories today) opens
  the messenger repository, and every local checkout of the framework (about 10 with worktrees) fetches
  the wrong history unless its remote is changed first.
- **npm.** `@wirecat/cli-core` keeps its framework versions (0.19.x) and then publishes the messenger
  package above them, continuing cli-messaging's numbers (0.23x). Pins such as `0.19.4` or
  `>=0.19.2 <0.20.0` never cross over; a bare `npm install @wirecat/cli-core` does.

So the order is strict, and each step finishes everywhere before the next:

**Phase 4 — the framework becomes cli-base.**
1. Publish the framework as `@wirecat/cli-base` (cli-core#84; 0.21.0 is the same code as 0.20.0 under the
   new name). The first version goes out from the owner's machine: npm's trusted publishing is set on a
   package that already exists. Done 2026-10-11.
2. Rename the GitHub repository `cli-core` → `cli-base`, inside an announced freeze, and merge one PR per
   repository moving `uses: WireCatLabs/cli-core/.github/workflows/…` to `cli-base/…` with the same pinned
   commit. GitHub [does not redirect](https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository)
   calls to actions or reusable workflows in a renamed repository, so CI and releases fail everywhere
   between the rename and those merges. Done 2026-10-11 at 20:14 UTC, with nine PRs merged within a
   minute. Then the owner adds the npm trusted publisher for `cli-base`.
3. Every repository switches `@wirecat/cli-core` → `@wirecat/cli-base` (imports, `biome.json` extends,
   tsconfig extends, lefthook, release scripts, prose), one PR each:
   `node <cli-base>/scripts/rename-package.ts --pass npm --version <x.y.z>`. **Producers first**
   (cli-testing, cli-messaging), apps after: an app on cli-base whose cli-messaging still peers cli-core
   installs two framework copies, and `instanceof` on errors fails between them. About 1,100 lines in
   tracked files (lockfiles and changelogs excluded).
4. Local checkouts of the framework: `git remote set-url origin …/cli-base.git`, any time before phase 5
   reuses the name (until then GitHub redirects git).
5. Last framework release under the old name: none. `@wirecat/cli-core` is not deprecated; it is about
   to be reused.

**Phase 5 — cli-messaging becomes cli-core.** Only after phase 4 is released in every app.
1. Rename the GitHub repository `cli-messaging` → `cli-core`. GitHub redirects the old messenger name;
   the old framework links stop redirecting, which is why phase 4 rewrote them all.
2. Publish the package as `@wirecat/cli-core`, next version above the last cli-messaging release.
3. Apps switch `@wirecat/cli-messaging` → `@wirecat/cli-core`. A last `@wirecat/cli-messaging` release
   re-exports `@wirecat/cli-core`; then `npm deprecate`.
4. Local checkouts of cli-messaging change their remote to `cli-core.git`. Before step 1, local checkouts of the
   framework must already point at `cli-base.git` (one `remote set-url`: they share one `.git`), since a new
   `cli-core` ends the redirect.
5. The two native add-ons move with it (owner, 2026-10-11): `@wirecat/cli-messaging-sqlite` →
   `@wirecat/cli-core-sqlite`, `@wirecat/cli-messaging-onnx` → `@wirecat/cli-core-onnx`, under
   `packages/sqlite` and `packages/onnx` as now. Only this package depends on them, so no app changes. Each new
   name is published empty once from the owner's machine (as `bin/publish-sqlite` did), then its trusted
   publisher names `WireCatLabs/cli-core` and `sqlite.yml` / `onnx.yml`; the old names get a last version and
   `npm deprecate`.
6. npm's trusted publisher for `@wirecat/cli-core` still names the framework's old repository: the owner points
   it at the new `cli-core` before the first release from it.

Status, 2026-10-14:
- Steps 1, 2, 4 and 5 done. Repository renamed 2026-10-13 21:45 UTC; #1072 renamed the package, #1080 moved the
  add-ons. `@wirecat/cli-core` 0.262.0 follows cli-messaging 0.261.0 (plus #1071 and #1073). The add-ons are on npm as
  `@wirecat/cli-core-sqlite` / `-onnx` 1.0.1.
- Step 6: all three trusted publishers failed with npm 404 until the owner re-created them (cli-private
  `bin/npm-trust-cli-core`).
- Step 3: tg, max, drive and the docs site are on cli-core in `main`; tg 0.53.0 is released on it. memo and zoom switch when they adopt 0.261+.
  The last `@wirecat/cli-messaging` and the deprecation of the three old names wait until every app's latest
  release is on cli-core (cli-private `bin/publish-cli-messaging-final` checks that).
- Kept on the old name on purpose: data folders, `MESSAGING_*` variables, the export format, and local checkout
  folders (`~/Projects/AI/cli-messaging`).
- Parity's `scripts/parity/build-app.sh` installs the checkout under the name the app imports. tg and max `main`
  are on cli-core now, so its `@wirecat/cli-messaging` fallback can go once no open tg/max branch still uses it.

## Done when

- cli-messaging has no `@wirecat/cli-tasks` or `@wirecat/cli-meetings` dependency.
- The boundary rules reject a forbidden import in CI.
- zoom-cli builds on the new paths; the old package names are deprecated on npm.
- No repository references `@wirecat/cli-messaging` or links to the framework as `WireCatLabs/cli-core`.
