# Plan: one shared cli-core, not a private copy in every CLI

Status: draft for the lead's review, 2026-11-28. Nothing here is built. A prototype was built and timed in a
scratch folder (see [Measurements](#measurements)); it changed no repository.

**Not verified:** npx; macOS and Windows; a server surviving (or failing) an upgrade under the new layout; that pnpm
removes the old `.pnpm/@wirecat+cli-core@<old>` folder on an update (inferred from the Desktop plan); that fewer,
larger chunks reach the +50 ms gate (decision 2 is a hypothesis until measured); a real `tsc` + `cli-dev bundle`
build of a CLI (the prototype bundled tg's existing `dist`).

## Goal

Each WireCat CLI ships only its own code in `dist/bundle`. The code of cli-core (and of cli-base) is loaded from the
`@wirecat/cli-core` package the CLI already depends on, which cli-core ships pre-bundled.

- About **14–15 MB less per CLI** (tg: 16.5 MB bundle → 1.7 MB).
- About **190–200 MB less on a full WireCat Desktop** (16 CLIs), because pnpm keeps one copy of each cli-core version.
- `--help` and short commands stay within **+50 ms of today** (median, warm compile cache), and stay well under the
  unbundled start that WC-LAY-10 replaced.
- No installed CLI breaks during the move: each CLI switches on its own release.

## Current state

- `cli-dev bundle` (cli-base `src/dev/bundle.ts`) bundles the CLI's `dist/` **and everything it imports**, cli-core,
  cli-base and their pure-JS libraries included. Only natives and a few late-loaded packages stay outside
  (`DEFAULT_EXTERNAL`, `bundle.ts:39-51`).
- cli-core and cli-base are "anchored" (`DEFAULT_ANCHORED`, `bundle.ts:53`): their `import.meta.url` is rewritten to
  `new URL(<path>, import.meta.resolve("@wirecat/cli-core"))` (`bundle.ts:114-123`), so a bundled copy still finds
  skills, templates and fonts in the installed package. That is why every CLI carries a copy **and** depends on the
  package.
- The build refuses a third-party module that imports an outside package, because it would resolve from the CLI's
  folder (`bundle.ts:293-301`); the reason is in the header comment (`bundle.ts:10`): pnpm installs cli-core's
  dependencies beside cli-core, not beside the CLI.
- For `serve`, `watch` and `mcp serve` the loader preloads every lazy chunk 2 s after start, so an in-place upgrade
  cannot remove a chunk under a running server (`bundle.ts:240`, list built at `bundle.ts:307`).
- WC-LAY-10 (cli-base `docs/standards/layout.md:125-133`) requires the bundle: tg's bundle halved `--help`.
- tg 0.138.0 today: 16.5 MB bundle = 1.66 MB tg + 8.38 MB cli-core + 6.43 MB cli-core's libraries. 15 CLIs pin
  cli-core 2.0.0 exactly, bitrix24-cli pins 1.0.0.
- cli-core 2.0.0 ships 1,669 `.js` files in `dist` (12.5 MB) and loads 1,349 of them for `tg --help` when nothing is
  bundled (measured, below).
- cli-core imports cli-base from 926 files and declares it a peer (`package.json:382`, `^1.0.0-0`), with commander
  (`package.json:383`). One instance of each is shared by the CLI and cli-core today only because both sit in one
  bundle.
- WireCat Desktop installs every tool with its own pnpm and one store (wirecat-desktop
  `docs/dev/plans/2026-11-27-pnpm-shared-install.md`, built in #494). Each tool has its own folder
  `global/v11/<hash>/`, but files of one package version are hard links to one store copy. So one cli-core version
  costs disk once; the private copies inside each CLI's bundle are different files per CLI and cost disk 16 times.
- In parallel (other agents, this week): cli-core bundles its own pure-JS libraries (MCP, zod, tldts, liquidjs, yaml,
  iconv-lite) into its `dist`, and voice, meaning search, readers, PNG charts and PDF move to the first-use installer
  (`2026-10-18-install-size.md`, items 6–9).

## Measurements

### How it was measured

Scratch folder `/home/leemour/.cache/tmp-shared-core`, 2026-11-28, Linux x64, Node 24.19.0, Bun 1.4.4. Source:
tg-cli 0.138.0 as built in `/home/leemour/Projects/AI/tg-cli` (its `dist/` and `node_modules`, cli-core 2.0.0,
cli-base 1.0.0). Nothing was installed or written outside the scratch folder.

Variants:

| Name | What it is |
|---|---|
| today | tg's own `dist/bin/tg.js` loader and `dist/bundle` (cli-core inside) |
| shared | cli-core pre-bundled with esbuild, code splitting, one entry per package export (51), its libraries inside; package `exports` pointed at the bundle entries. tg bundled with `@wirecat/cli-core*`, `@wirecat/cli-base*` and `commander` external. cli-base unbundled. |
| shared2 | as shared, plus cli-base pre-bundled the same way (18 entries, 49 files, 0.74 MB) |
| shared3 | as shared2, but cli-core's bundle has only the 10 entries tg imports (157 files instead of 325) |
| raw | no bundle at all: tsc output of tg against the installed cli-core |

Build scripts: `tools/bundle-core.mjs` (adapted from `bundle.ts`: entries from `exports`, splitting, the
`common-js-names` plugin, `import.meta.url` of cli-core's own files rewritten to their original place) and
`tools/bundle-cli.mjs` (calls cli-base 1.0.0's own `bundle()` with the extra externals).

Commands: `tg --help`, `tg commands`, and `tg doctor` as the offline command (it reads the config, opens the SQLite
store, checks readers and the package's own files; no network). Every store command needs a logged-in profile, which a
scratch home cannot have. `NO_UPDATE_NOTIFIER=1`, temp `HOME`, `XDG_*`.

- **Cold** = empty compile cache: a fresh empty `TMPDIR` per run (the loader's `enableCompileCache()` writes under
  `os.tmpdir()`; checked that the folder is filled after a run). The OS page cache stays warm; dropping it needs root.
- **Warm** = one fixed `TMPDIR` per variant, one priming run thrown away.
- 10 runs each, variants interleaved (A B C A B C…), median with min–max. The machine was busy (load average 13–26 on
  24 cores, other agents' builds), so absolute numbers are high and noisy; the gaps between variants in the same run
  are the result.

Correctness: stdout of `--help` and `commands` is byte-identical in all variants, `doctor` identical after removing
run id and timings; the same under Bun.

### Start time, Node (ms, median; min–max)

Run 1 (today / shared / raw):

| | today | shared | raw |
|---|---|---|---|
| cold `--help` | 895 (806–1046) | 1098 (900–2101) | 2058 (1590–2516) |
| cold `commands` | 929 (741–1018) | 1070 (970–1175) | 2007 (1692–2093) |
| cold `doctor` | 811 (685–919) | 979 (920–1123) | 1654 (1446–1897) |
| warm `--help` | 469 (399–780) | 602 (539–725) | 1132 (1002–1504) |
| warm `commands` | 521 (374–700) | 616 (578–770) | 1142 (1032–1717) |
| warm `doctor` | 451 (410–907) | 577 (457–657) | 953 (848–1233) |

Run 2 (all shared variants; machine slightly less busy):

| | today | shared | shared2 | shared3 |
|---|---|---|---|---|
| cold `--help` | 604 | 772 | 789 | 671 |
| cold `commands` | 746 | 938 | 873 | 780 |
| cold `doctor` | 674 | 846 | 807 | 767 |
| warm `--help` | 454 | 677 | 571 | 553 |
| warm `commands` | 473 | 574 | 574 | 544 |
| warm `doctor` | 488 | 638 | 659 | 581 |

### Start time, Bun 1.4.4 (warm only: Bun has no compile cache; ms, median, min–max)

| | today | shared3 | raw |
|---|---|---|---|
| `--help` | 600 (452–758) | 650 (468–759) | 1015 (857–1545) |
| `commands` | 667 (503–873) | 675 (568–905) | 1051 (977–1427) |
| `doctor` | 712 (581–850) | 751 (536–1271) | 1119 (969–1496) |

Under Bun the gap is 10–50 ms; under Node it is 70–130 ms.

### What each variant loads (`--help`, a `module.registerHooks` load counter, run apart from the timing)

| | files loaded | code bytes |
|---|---|---|
| today | 77 (76 bundle chunks) | 10.7 MB |
| shared | 283 (182 cli-core chunks, 61 cli-base files, 30 third-party, 10 tg) | 11.9 MB |
| shared2 | 246 | 11.7 MB |
| shared3 | 161 | 10.9 MB |
| raw | 1,560 (1,349 cli-core files) | — |

Reading: the bytes are about the same, so the extra time most likely follows the **number of files** (inferred:
shared3 cut files from 283 to 161 and the gap from ~+150 to ~+90 ms; not shown that it closes further). esbuild's
splitting makes one chunk per distinct set of entries that reach a module, so 51 entries give 325 small chunks and
`--help` touches 182 of them. cli-base unbundled costs about 60 files; pre-bundling it helped on `--help` (shared vs
shared2) and is worth doing. In shared3, 12 of the remaining files are `cross-spawn` and its helpers, left outside
cli-base's bundle by the prototype; they can go inside.

One instance check (load list of `shared3 doctor`, real paths): one cli-base folder, one commander folder, one
cli-core folder.

### Size

| | today | shared (prototype) |
|---|---|---|
| tg `dist/bundle` | 16.5 MB | 1.7 MB |
| cli-core `dist/bundle` (once per cli-core version) | — | 17.8 MB (51 entries; 14.4 MB with tg's 10) |
| cli-core `dist/*.js` it would replace | 12.5 MB | — |
| cli-base `dist/bundle` | — | 0.74 MB |

The 17.8 MB inlines cli-core's pure-JS libraries, which in the prototype also still sit in `node_modules`. Once the
parallel work moves them to `devDependencies` (bundled into cli-core's `dist`), that duplicate is gone.

Saved, assuming the cli-core bundle **replaces** its unbundled `dist/*.js` (keeping `.d.ts` and data files):

- **Per CLI: about 14.8 MB** (tg), 13–15 MB for the others.
- **Full Desktop on pnpm: about 185–190 MB now, about 200 MB later**: 15 CLIs on cli-core 2.0.0 lose ~13–15 MB of
  private copy each (~205 MB × 15/16 ≈ 192 MB), minus ~5 MB once for the one shared 2.0.x bundle (17.8 MB in place
  of 12.5 MB of `.js`) while the libraries are still duplicated. bitrix24-cli on 1.0.0 keeps its private copy until
  it moves (L2), then saves its ~13 MB too.
- **npm `-g` without Desktop** (each CLI has its own full `node_modules`): about 9.5 MB per CLI now, about 14.8 MB
  once the libraries leave `node_modules`.
- If the bundle were shipped **beside** `dist/*.js` instead, npm users would gain about 3 MB per CLI only; not worth it.

## Options

| Option | `--help` warm vs today (Node) | Saved per CLI | Notes |
|---|---|---|---|
| A. Keep the private copy (today) | 0 | 0 | ~205 MB on Desktop stays |
| B. No bundle, compile cache only (raw) | +480–660 ms (about 2×) | ~15 MB | undoes WC-LAY-10 |
| C. Shared cli-core, 51 entries, cli-base unbundled (shared) | +100–220 ms | ~14.8 MB | simplest build |
| D. C + cli-base pre-bundled (shared2) | +100–170 ms | ~14.8 MB | |
| E. D with tg's 10 entries only (shared3) | +70–100 ms | ~14.8 MB | lower bound for entry count; not shippable as is, other CLIs use other entries |
| F. D with chunk merging (rolldown `advancedChunks`, or esbuild + a merge pass) | not measured | ~14.8 MB | the proposed target |

## Verdict

**Go, with conditions.** The shared cli-core is about twice as fast as no bundle and removes ~93 % of each CLI's
bundle. As prototyped it is **70–130 ms slower** than today on a warm start (shared3 against today). The release waits
for the conditions in [Decisions](#decisions): fewer, larger cli-core chunks, cli-base pre-bundled, a preload for
servers, and an install-size and start-time gate.

## What breaks, and the answer to each

### 1. Two instances of cli-base or commander

cli-core imports cli-base from 926 files. If a CLI bundles cli-base while the external cli-core loads the installed
one, there are two copies: `instanceof` on cli-base's error classes and any module-level state split in two. The
prototype avoided it by making `@wirecat/cli-base*` and `commander` external in both bundles; with pnpm and npm both
resolve to one folder (cli-base and commander are peers of cli-core). **Rule: whatever cli-core declares as a peer is
external in the CLI's bundle too.** `cli-dev bundle` enforces it by reading cli-core's `peerDependencies`.

Where identity matters (grep of cli-core 2.0.0 `dist`): `instanceof CliError` from cli-base at 147 places and
`instanceof Command` from commander at 4; both are peers, so covered. Other packages both sides import, like
`valibot` (tg imports it in 7 files), become two copies: one inside cli-core's bundle, one in the CLI's. cli-core has no
`instanceof ValiError` and valibot schemas are plain objects, so this looks harmless (inferred); the rule for the
future is "a package whose classes or state cross between a CLI and cli-core must be a peer of cli-core".

### 2. Version skew

Today a CLI runs the cli-core it was built with, by construction. After the change it runs the cli-core in its
`node_modules`.

- With **exact pins** (today's rule) the installed version is the built-against version under npm, pnpm, Desktop's
  pnpm, npx and Bun: each resolves the CLI's own exact dependency. No skew.
- Skew appears only if a pin becomes a range, a user adds `overrides`, or a monorepo hoists another version. Guard:
  `cli-dev bundle` refuses a non-exact `@wirecat/cli-core` / `@wirecat/cli-base` range, writes the version it built
  against into the loader, and the loader compares it with the installed `package.json` version only when a test env
  or `doctor` asks (no extra file read on a normal start). `doctor` reports a mismatch.
- The public API is now a runtime contract, not just a type contract: a CLI can only use what cli-core `exports`.
  esbuild already respects `exports`, so no CLI reaches inside today; the contract test is that the CLI bundle
  contains no `node_modules/@wirecat/cli-core` path.

### 3. Desktop's pnpm global installs

Each tool keeps its own folder and its own exact cli-core; tools on the same version share the store files (hard
links), tools on another version get another copy. Nothing in Desktop changes. The saving comes for free and grows as
the CLIs converge on one cli-core version. bitrix24-cli on 1.0.0 keeps its own private copy until it moves.

### 4. In-place upgrade under a running server (blocks rollout until built)

The loader preloads only the CLI's own lazy chunks (`bundle.ts:240`). cli-core's chunks have hashed names too, and an
upgrade that changes the cli-core version replaces them under a running `tg serve`: under npm in place, under pnpm the
old `.pnpm/@wirecat+cli-core@<old>` folder is most likely removed with the update (inferred, not run). A server that had not loaded a cli-core chunk
yet would fail on the next lazy import. Fix: cli-core writes `dist/bundle/chunks.json` and exports
`@wirecat/cli-core/preload`, which imports every chunk; the loader calls it with its own preload for a server. The
existing resolve hook for `./` imports inside the bundle (`bundle.ts:230`) is extended to cli-core's bundle folder.

### 5. npx

`npx @wirecat/tg-cli` installs the CLI with its exact cli-core into the npx cache, so resolution should be the same
as npm (inferred, not run). The test plan runs it.

### 6. Bun

The prototype's output under Bun 1.4.4 matches Node for all variants. Bun has no `module.registerHooks`; the loader
already skips the hook there. The server preload (item 4) must work without it: plain `import()` of each chunk does.

### 7. `import.meta.resolve` and file lookups

- The anchoring of cli-core in the CLI's bundle (`bundle.ts:114-123`) is no longer needed: cli-core is not in the
  CLI's bundle. cli-base's anchoring goes too once cli-base is external.
- Inside cli-core's own bundle, its 13 files that use `import.meta.url` are rewritten to their original place
  (`new URL("<path>", import.meta.url)`), so `../skills`, templates, fonts and snowball data resolve exactly as now,
  even after the unbundled `.js` files are deleted. Its 4 `import.meta.resolve(name)` calls (dictionaries, readers'
  engine check) resolve from inside the same package and need no change. Checked: `doctor`'s file check passes in the
  prototype.
- cli-core starts no worker from its own file (no `new Worker` in `dist`); child processes re-run the CLI's bin.
- Found while building: cli-base 1.0.0's `cli-dev bundle` **refuses** to bundle a pre-bundled cli-core privately:
  cli-core's chunks import natives (`@napi-rs/canvas`, `@huggingface/tokenizers`, `@resvg/resvg-js`,
  `ogg-opus-decoder`) as static imports, which the check at `bundle.ts:293-301` rejects. So a CLI cannot take the new
  cli-core without the new cli-base. It fails at build time, loudly; installed CLIs are not affected.
- Found while building: cli-dev bundle prepends an import line to a CLI module it rewrites, and a bin with a `#!`
  line then fails to build once `@wirecat/cli-core/cli/start` is external (the lazy import in `tg.ts` gets rewritten).
  The plugin must keep a leading `#!` first.

### 8. Other consumers of cli-core

Tests and scripts that import `@wirecat/cli-core` (vitest in each CLI, cli-testing) load the bundle instead of the
unbundled files. Stack traces point into chunks; source maps are already dropped (install-size item 2). Vitest's
module mocking of cli-core internals stops working; grep for `vi.mock("@wirecat/cli-core` before step C2.

## Decisions (proposed)

1. **cli-core ships its `dist` as a pre-bundled, code-split ESM bundle that replaces the unbundled `.js` files**;
   `.d.ts`, data files and templates stay where they are. `exports` point at the bundle entries.
2. **Fewer, larger chunks.** Constraint: every public entry must be in **one** build (two builds would give two
   copies of shared modules), and an entry cannot be a re-export of a start-path entry (that pulls its code into the
   start path). So the only lever is merging chunks: esbuild cannot, so either rolldown with `advancedChunks` (group
   by size and by "reached from the start path") or a pass after esbuild that concatenates chunks only ever loaded
   together. Unverified: whether this reaches the gate in decision 6. Measure first (work item C0).
3. **cli-base is pre-bundled the same way**, and stays a peer of cli-core.
4. **Peers of cli-core are external in every CLI bundle** (cli-base, commander), enforced by `cli-dev bundle`.
5. **Exact pins stay** for cli-core and cli-base in every CLI; `cli-dev bundle` refuses a range.
6. **Gate:** in cli-template's CI, warm `--help` of the template CLI built the new way is at most 50 ms (and 10 %)
   above the same CLI built the old way, median of 10 interleaved runs; and each CLI's `dist/bundle` is under 3 MB.
7. **`cli-dev bundle` keeps the old mode** (`--private-core`) for one minor version, so a CLI can go back with one flag.
   It must accept a pre-bundled cli-core too (rewrite its static native imports to `importFrom`), or going back also
   means going back to the old cli-core.

## Work items, in order

### cli-core

- C0. Prototype the chunk merging (decision 2) on the template CLI and tg; measure against the gate. Stop here if it
  cannot reach it, and bring the numbers back to the owner (open question 1).
- C1. `scripts/bundle-dist.ts`: after `tsc` and the existing `bundle-*` scripts, bundle `dist` per decisions 1–2,
  rewrite `exports`, delete the unbundled `.js`, write `dist/bundle/chunks.json`. Reuse cli-base's plugins
  (`common-js-names`, the `import.meta.url` rewrite) by importing them from `@wirecat/cli-base/dev`, not by copying.
- C2. `@wirecat/cli-core/preload` export (problem 4).
- C3. `check:dist` runs the test suite's dist checks against the bundle; `install-size.ts` ceiling lowered by the
  measured amount.
- C4. A test that every `exports` entry loads under Node and Bun, and that no bundled chunk contains a path into
  `node_modules/@wirecat/cli-base` or `commander`.
- Release as a **minor** version: the public API is unchanged.

### cli-base

- B1. cli-base pre-bundled (decision 3), its own release first: cli-core's bundle imports it.
- B2. `cli-dev bundle`: externalize `@wirecat/cli-core*`, `@wirecat/cli-base*` and cli-core's peers by default; drop
  them from `DEFAULT_ANCHORED`; allow an anchored package to import them (`bundle.ts:293-301`); refuse non-exact pins;
  keep `#!` first; the loader calls `@wirecat/cli-core/preload` for a server. `--private-core` keeps today's mode.
- B3. WC-LAY-10 text: the CLI's bundle holds only the CLI's code; the shared core is pre-bundled; the new gate.

### cli-template

- T1. Bump cli-base and cli-core; `pnpm build` unchanged (the default changed). Add the start-time and size gate
  (decision 6) to its CI; this is the reference for every CLI.

### Each CLI (16)

- L1. Dependabot bump of cli-base and cli-core to the new versions; no source change expected. Run `pnpm build`,
  `smoke:node`, `smoke:bun`, `parity:check`, the test suite. Release.
- L2. bitrix24-cli first moves from cli-core 1.0.0 to the current version (its own task; until then it keeps the
  private copy through the old cli-dev bundle it pins).

## Migration order

1. cli-base B1 (pre-bundled) and B2–B3 (new `cli-dev bundle`), one release. B2 must also accept today's unbundled
   cli-core 2.0.0, so CLIs can take it alone.
2. cli-core C0–C4, release (minor). Measured: the old `cli-dev bundle` refuses it (see problem 7), so **a CLI bumps
   cli-base and cli-core together** (one Dependabot group), never cli-core alone. Already installed CLIs are not
   affected: they keep their exact pins.
3. cli-template T1: the gate runs here first.
4. tg-cli (the biggest user, the one the standard was proven on), then the rest in Dependabot waves.
5. After all 16 have moved: remove `--private-core` in the next cli-base major.

## Rollout and installed CLIs

- A CLI already installed keeps its private copy and keeps working: nothing it loads changes until its own update.
- An updated CLI brings its exact cli-core with it in the same install (npm, pnpm, npx, Desktop). There is no moment
  where a new CLI meets an old cli-core.
- Desktop needs no change. Its post-install check (`<bin> commands --json`, wirecat-desktop `own_pnpm.rs`) already
  loads the command tree, so a broken bundle fails the install and Desktop keeps the old copy.
- Running servers: a server started before its update keeps its old chunks in memory once C2/B2 preload them; one
  started on the old private-copy build is safe as today.

## Test plan

- The prototype's checks, made permanent in cli-template CI: byte-identical `--help` and `commands` against the old
  build; `doctor` identical; the timing gate (decision 6).
- cli-core: every `exports` entry imports under Node 22, 24 and Bun (C4); skills, templates, fonts and dictionaries
  found from the bundle (`doctor` file check, `skill install` into a temp home, a chart render, a Russian search).
- Server upgrade: start `tg serve` in a temp home, replace the installed cli-core with the next version's files, run a
  command through the server that hits a lazy cli-core chunk; it must answer.
- Two instances: a test that `require.cache`-style load counting shows one cli-base and one commander folder.
- Desktop: `bin/install-e2e real_tool_e2e` with a tg built the new way; two tools on one cli-core share its files
  (link count above 1).
- npx and a global npm install of a packed tg in a temp prefix (never the user's nvm prefix).

## Open questions for the owner

1. **Is +50 ms (10 %) on a warm `--help` the right ceiling**, given that today's bundle saved about 600 ms against no
   bundle? The prototype is at +70–130 ms before the chunk work in decision 2.
2. **Bundle cli-core's own pure-JS libraries into this bundle** (as the parallel work does), or keep them as
   dependencies? Bundling keeps the start fast; keeping them lets Dependabot bump them without a cli-core release.
3. **May the 51 public entries shrink**, for example by folding rarely used subpaths (`./documents/testing`,
   `./sftp`…) into a few? Fewer entries is the cheapest way to fewer chunks, but it is a breaking change for any
   outside importer.

## Owner's decision (2026-11-28)

1. **Start-time ceiling: +50 ms** on a warm `--help` against today's bundled CLI. Reach it by optimising the chunks;
   a slower result is not shipped.
2. **The public entries shrink in 3.0.** Rethink the import paths as part of it (fewer entries, how CLIs import
   them), since 3.0 is a breaking release and every CLI moves to it anyway.
3. **This ships in cli-core 3.0**, together with the rest of the install-size work, not as a later minor. Order:
   cli-base and cli-core release first, then the CLIs.
