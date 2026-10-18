# Plan: a smaller install

Status: draft for the owner's review. Nothing here is built.

## Goal

A fresh `npm i @wirecat/max-cli` takes 244 MB on disk today. Most of it is code for features a person may
never use: charts, voice transcription, search by meaning, one model provider. The target:

- **Under 100 MB** for a default install of max-cli (and so of tg-cli and the other CLIs on cli-core).
- **About 75 MB** if the owner also agrees to make the web-page reader optional (open question 3).
- **No `npm audit` alert** on a fresh install.
- Every feature still works. A feature whose code is not installed says what to run, and installs it on first
  use the way speech and meaning-search models already download.

## Current state

### How it was measured

On 2026-10-18, on Linux x64, npm 11:

```sh
npm i --prefix "$T" --ignore-scripts --no-audit --no-fund @wirecat/max-cli   # max-cli 0.62.0, cli-core 0.342.0
du -sh "$T/node_modules"                                                      # disk use
du -sh --apparent-size "$T/node_modules"                                      # bytes in files
```

130 packages, **244 MB on disk, 201 MB in file bytes**. Sizes below are disk use (what a person sees), unless
marked. "Removed" means every package that only that dependency pulls in, worked out from npm's lock file in
the install, by the script in the [appendix](#appendix-how-the-removed-sizes-were-computed).

| What | Removed with it | Size | Pulled in by |
|---|---|---|---|
| Charts: `echarts` | `zrender`, `tslib` | **67 MB** | `package.json:170` |
| Voice: `sherpa-onnx`, `ogg-opus-decoder` | `@wasm-audio-decoders/*`, `opus-decoder`, `codec-parser`, 3 more | **33 MB** | `package.json:178,181`; max-cli `package.json:110,112` |
| Anthropic adapter: `@anthropic-ai/sdk` | `json-schema-to-ts`, `@babel/runtime`, `ts-algebra`, 3 more | **21 MB** | `package.json:159` |
| cli-core's own `dist` | — | 22 MB (13 MB in bytes) | — |
| … of which source maps | 1,635 `.map` files | 9.7 MB (5.4 MB in bytes) | cli-base `config/tsconfig.base.json` (`sourceMap`, `declarationMap`) |
| MCP server: `@modelcontextprotocol/server` | `@modelcontextprotocol/core`, `zod` | 16 MB | max-cli and cli-core |
| Meaning search: `@wirecat/cli-core-onnx` | `onnxruntime-common`, `@huggingface/tokenizers` | **15 MB** | `package.json:161,165` |
| Web-page reader: `defuddle` | `turndown`, `@mixmark-io/domino` (8.9 MB), `temml`, `mathml-to-latex` | 15 MB | `package.json:169` |
| HTML reader: `linkedom` | `htmlparser2`, `css-select` and 15 more | 10 MB | — |
| Word reader: `mammoth` | `argparse` → `sprintf-js`, `underscore`, `jszip`, `pako` and 17 more | **8 MB** | `package.json:177` |
| PNG charts: `@resvg/resvg-js` | its native binary | 4 MB | — |

The source maps are useless to a reader of the package: each one points at `../src/*.ts`, `src` is not in
`files` (`package.json:16`), and the maps carry no `sourcesContent`. Checked on
`dist/documents.js.map` of the installed 0.342.0.

`npm audit` on the install reports 5 moderate findings, all one chain:
[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) in `sprintf-js`, through `argparse`
1.0.10, which `mammoth` 1.13.0 needs only for its own command line. npm offers no fix.

### What already loads late

Run time is not the problem — the disk is. Every heavy library is already imported only when its feature runs:

- Charts: `src/charts/render.ts:3` imports `src/charts/echarts.ts` on demand. That file uses only
  `echarts/core`, the bar and line charts and the SVG renderer (`src/charts/echarts.ts:1-4`). 51 MB of echarts
  is its prebuilt `dist/` bundles, which nothing here loads.
- Voice: `src/speech/recognize.ts:39` imports `ogg-opus-decoder` on demand; `loadSherpa`
  (`src/speech/recognize.ts:108-122`) requires `sherpa-onnx` on first use.
- Meaning search: `src/embeddings/embed.ts:138` and `src/images/picture/embedder.ts:21` import
  `@wirecat/cli-core-onnx` on demand.
- Anthropic: `src/models/index.ts:38` imports `src/models/anthropic.ts` on demand. The OpenAI adapter next to it
  (`src/models/openai.ts`, 63 lines) uses plain `fetch` and no SDK.
- Readers: `withEngine` (`src/readers/engine.ts:39-60`) loads each reader on demand and already returns
  `engine-missing` when the package is not installed (`src/readers/engine.ts:18-19`). The owner ruled on
  2026-10-12 that readers ship with the package (`src/readers/engine.ts:11-13`).
- Model files already download on first use: `install` / `installFiles` (`src/speech/install.ts:69-147`) fetch
  each file into `~/.local/share/WireCat/models/<kind>`, check its sha256 and rename it into place.

### What cannot shrink

- `zod` (8 MB) comes with `@modelcontextprotocol/server`, which max-cli needs for `mcp`. It stays.
- `optionalDependencies` do not help: npm installs them by default. Only an optional peer dependency, or a
  download at first use, keeps a package off a default install.
- `overrides` in a library's `package.json` do not reach the people who install it, so `sprintf-js` cannot be
  replaced from here while `mammoth` needs it.

## Options, per dependency

### 1. Charts: bundle the parts we use (67 MB → about 1.4 MB)

`esbuild src/charts/echarts.ts --bundle` gives 1.4 MB (570 KB minified). `scripts/bundle-drizzle.ts` already
bundles a dependency into `dist` this way. `echarts` moves to `devDependencies`; the bundle's Apache-2.0
notice goes into `THIRD_PARTY_NOTICES`.

- For: the biggest saving, no change for the user, charts still work offline.
- Against: echarts updates come through a rebuild, not through a Dependabot bump of the dependency alone; the
  licence notice has to be kept in step by hand.

### 2. Voice: install on first use (33 MB)

`sherpa-onnx` and `ogg-opus-decoder` leave `dependencies` in cli-core **and in max-cli**. The first
`transcribe` (or `speech install`) installs them, pinned by version and integrity hash, into
`~/.local/share/WireCat/engines/` beside the models it already downloads, and loads them from there.

- For: voice users already wait for a model download of hundreds of MB; 33 MB more is small next to it.
- Against: a second install mechanism to keep safe (pinned versions, hashes, no install scripts). It needs a
  test that a missing engine gives `engine-missing` with the command to run, never a crash.
- Alternative: make them optional peer dependencies and tell the user to run `npm i -g sherpa-onnx …`. Simpler,
  but it breaks under `npx` and asks the user to match versions by hand.

### 3. Meaning search: install on first use (15 MB)

Same mechanism as voice, for `@wirecat/cli-core-onnx` and `@huggingface/tokenizers`. Meaning search is opt in
already, and its model is downloaded on first use.

### 4. Anthropic: call the API with `fetch` (21 MB → 0)

Rewrite `src/models/anthropic.ts` like `src/models/openai.ts`: one `POST /v1/messages` with streaming, no SDK.
The adapter uses one call (`messages.stream`), so the surface is small.

- For: 21 MB and six packages gone; both providers built the same way.
- Against: we own the request and the streamed event parsing. Bundling the SDK instead (300 KB minified)
  keeps its behaviour, but ships code we do not read.

### 5. Source maps: stop publishing them (9.7 MB)

They point at sources that are not in the package. Either drop `*.map` from `files` (add `"!dist/**/*.map"`), or
turn `sourceMap` and `declarationMap` off for the release build only. The first is one line and keeps local
debugging as it is.

### 6. Word reader: replace mammoth (8 MB, and the audit alert)

`fflate` and `@xmldom/xmldom` are already dependencies. A `.docx` file is a zip with `word/document.xml`; the
text the store keeps is the paragraphs and table cells, which a reader over those two packages can give in
about a hundred lines. drive-cli also depends on `mammoth` directly (its `package.json:69`) and needs the same
change.

- For: 8 MB and 22 packages gone, and the only `npm audit` finding.
- Against: mammoth handles lists, footnotes and odd files we would now meet ourselves. The current reader
  tests and a set of real-world `.docx` fixtures decide whether the replacement is good enough.

### 7. Web-page and HTML readers (25 MB) — only with the owner's yes

`defuddle` (15 MB) and `linkedom` (10 MB) could become first-use installs like voice. This reverses the ruling
that readers ship with the package, so it waits for the owner (open question 3).

## Expected result

| Step | Saves (disk) | Install after it |
|---|---|---|
| Today | — | 244 MB |
| 1 Charts bundled | 66 MB | 178 MB |
| 4 Anthropic over `fetch` | 21 MB | 157 MB |
| 5 No source maps | 10 MB | 147 MB |
| 6 Own Word reader | 8 MB | 139 MB |
| 2 Voice on first use | 33 MB | 106 MB |
| 3 Meaning search on first use | 15 MB | **91 MB** |
| 7 Readers on first use (owner's call) | 15–25 MB | **66–76 MB** |

The numbers add up the measured sizes; each step is measured again when it is built.

## Work items, in order

Cheap and safe first; the first-use installer last, because it is the only new mechanism.

1. **Measure in CI.** A script that installs the packed tarball with `--ignore-scripts` and prints the size and
   the five largest packages, run in the release workflow. It fails above a ceiling that each step lowers.
2. **Drop source maps from the package** (`files`), and check that `npm pack --dry-run` lists no `.map`.
3. **Bundle echarts** into `dist/charts/`, move it to `devDependencies`, add its notice.
4. **Anthropic adapter over `fetch`**, remove the SDK.
5. **Own `.docx` reader** over `fflate` and `@xmldom/xmldom`; remove `mammoth` here and in drive-cli.
6. **First-use installer** for engines: pinned versions and integrity hashes, no install scripts, into the shared
   WireCat data folder, with `doctor` showing what is installed.
7. **Voice on the installer**: remove `sherpa-onnx` and `ogg-opus-decoder` from cli-core and max-cli.
8. **Meaning search on the installer**: remove `@wirecat/cli-core-onnx` and `@huggingface/tokenizers`.
9. **Readers on the installer**, only if the owner says yes.

Each item is its own pull request and its own release note. Items 7 and 8 change max-cli and tg-cli too.

## Test plan

- The size script from item 1 on every release, with the ceiling.
- Charts: the current chart tests run against the bundle in `dist` (`pnpm check:dist` already loads `dist`),
  plus one test that the published files contain no import of `echarts`.
- Anthropic: the model adapter tests over a fake `fetch`, covering a streamed answer, an error answer and a cut
  stream; one live call by the owner before release.
- Word reader: the existing reader tests, plus fixtures for lists, tables, footnotes and a damaged file; the
  extracted text compared with what mammoth gives on the same files.
- Installer: a missing engine gives `engine-missing` and the command to run; a wrong hash refuses the file and
  installs nothing; an interrupted install leaves nothing half-written; it never runs package scripts.
- On Node and on Bun: voice and meaning search work after a first-use install from an empty data folder.
- `npm audit` on a fresh install reports nothing.

## Open questions for the owner

1. **Is a first-use install acceptable for voice and meaning search?** The first `transcribe` would download
   about 33 MB of engine code before the model. The alternative keeps them in every install.
2. **Should the Anthropic adapter drop the SDK** and talk to the API directly, as the OpenAI one does?
3. **May the web-page and HTML readers become first-use installs** (15–25 MB more), reversing the
   2026-10-12 ruling that readers ship with the package?
4. **Is 100 MB the right ceiling** for the release check, or should it be lower once item 9 is decided?

## Appendix: how the removed sizes were computed

The script reads `node_modules/.package-lock.json` of the test install, walks the dependency tree from
`@wirecat/max-cli` once with and once without the named packages, and adds up `du -sk` of every package only
the first walk reaches:

```sh
node reach.mjs "$T" '{"echarts":["echarts"],"speech":["sherpa-onnx","ogg-opus-decoder"]}'
```

`reach.mjs`:

```js
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
const root = process.argv[2]
const lock = JSON.parse(readFileSync(`${root}/node_modules/.package-lock.json`, "utf8")).packages
const size = (p) => Number(execFileSync("du", ["-sk", `${root}/${p}`]).toString().split("\t")[0])
const resolve = (from, name) => {
  let dir = from
  while (true) {
    const c = `${dir ? dir + "/" : ""}node_modules/${name}`
    if (lock[c]) return c
    if (!dir) return undefined
    const i = dir.lastIndexOf("/node_modules/")
    dir = i < 0 ? "" : dir.slice(0, i)
  }
}
const reach = (cut) => {
  const seen = new Set()
  const walk = (p) => {
    if (seen.has(p)) return
    seen.add(p)
    const e = lock[p]
    for (const n of Object.keys({ ...e.dependencies, ...e.optionalDependencies })) {
      if (cut.has(n)) continue
      const r = resolve(p, n)
      if (r) walk(r)
    }
  }
  walk("node_modules/@wirecat/max-cli")
  return seen
}
const all = reach(new Set())
const total = [...all].filter((p) => !p.slice(13).includes("/node_modules/")).reduce((s, p) => s + size(p), 0)
console.log("total KB (top-level dirs)", total)
const groups = JSON.parse(process.argv[3])
for (const [label, cut] of Object.entries(groups)) {
  const kept = reach(new Set(cut))
  const gone = [...all].filter((p) => !kept.has(p))
  const kb = gone.reduce((s, p) => s + size(p), 0)
  console.log(label, Math.round(kb / 1024) + "M", gone.map((p) => p.replace(/^node_modules\//, "")).join(" "))
}
```
