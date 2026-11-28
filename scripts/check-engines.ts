import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { fixtureEngine, packageFiles, serveRegistry } from "../src/testing/engine-fixtures.ts"
import { scratch } from "./scratch.ts"

const runtime = typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? "node" : "bun"

/**
 * The built installer, from an empty data folder, under whichever runtime runs this: a test engine from a registry on
 * 127.0.0.1 always, and with `ENGINE_CHECK_REAL=1` the engines cli-core pins, from npm, and voice on them.
 */
export const checkEngines = async (dist: string): Promise<void> => {
  const { ensureEngine, engineRequire, importFromEngine } = await import(
    pathToFileURL(join(dist, "engines/install.js")).href
  )
  const files = new Map<string, Uint8Array>()
  const registry = await serveRegistry(files)
  try {
    const { pin, bodies } = fixtureEngine(registry.base, "dist-engine", "1.0.0", [
      { name: "dist-engine", version: "1.0.0", files: packageFiles("dist-engine", "1.0.0", "engine", "dist-helper") },
      { name: "dist-helper", version: "1.0.0", files: packageFiles("dist-helper", "1.0.0", "helper") },
    ])
    for (const [url, body] of bodies) files.set(new URL(url).pathname, body)
    const env = { WIRECAT_STATE_DIR: scratch("core-dist-engines-") }
    const state = await ensureEngine(pin, { retry: "check", env })
    if (state.status !== "ready" || !state.installed)
      throw new Error(`${runtime}: no engine installed: ${state.reason}`)
    const loaded = engineRequire(state.folder)("dist-engine")
    const imported = await importFromEngine(state.folder, "dist-helper")
    if (loaded.needs !== "helper" || imported.default.answer !== "helper")
      throw new Error(`${runtime}: the installed engine did not load from its folder`)
    const again = await ensureEngine(pin, { retry: "check", env })
    if (again.status !== "ready" || again.installed) throw new Error(`${runtime}: the engine was installed twice`)
  } finally {
    registry.server.close()
  }
  console.log(`dist (${runtime}): an engine installs into an empty data folder and loads from it`)

  if (process.env.ENGINE_CHECK_REAL !== "1") return
  await checkVoice(dist)
  await checkMeaning(dist)
}

const TINY = {
  id: "tiny",
  title: "a five-word model",
  languages: "test",
  licence: "none",
  dims: 4,
  maxTokens: 64,
  chunksPerSecond: 1,
  pooling: "mean",
  prefix: { query: "", passage: "" },
  onnx: "onnx/model.onnx",
  files: [],
}

/** No file of `dist` loads the meaning engines' packages itself: only the installer's folder may provide them. */
const bareImports = (dist: string): string[] =>
  readdirSync(dist, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".js"))
    .filter((path) =>
      /(?:from\s*|import\(\s*|require\(\s*)["'](@wirecat\/cli-core-onnx|@huggingface\/tokenizers)["']/.test(
        readFileSync(join(dist, path), "utf8"),
      ),
    )

/** Search by meaning from an empty data folder: both engines from npm, then a synthetic word found by meaning. */
const checkMeaning = async (dist: string): Promise<void> => {
  const bare = bareImports(dist)
  if (bare.length > 0) throw new Error(`${runtime}: ${bare.join(", ")} import the meaning engines' packages directly`)
  const { openEmbedder } = await import(pathToFileURL(join(dist, "embeddings/embed.js")).href)
  const { isEngineInstalled } = await import(pathToFileURL(join(dist, "engines/install.js")).href)
  const { MEANING_ENGINES } = await import(pathToFileURL(join(dist, "embeddings/engine.js")).href)
  const env = { WIRECAT_STATE_DIR: scratch("core-dist-meaning-") }
  const embedder = await openEmbedder(TINY, join(import.meta.dirname, "../src/embeddings/fixtures"), {
    threads: 1,
    engine: { env, progress: (line: string) => console.error(line) },
  })
  let best: string | undefined
  try {
    const passages = ["dog", "kitten", "fish"]
    const [query]: Float32Array[] = await embedder.embed(["cat"], "query")
    const vectors: Float32Array[] = await embedder.embed(passages, "passage")
    const scores = vectors.map((vector) => vector.reduce((sum, value, index) => sum + value * (query?.[index] ?? 0), 0))
    best = passages[scores.indexOf(Math.max(...scores))]
  } finally {
    await embedder.close()
  }
  if (best !== "kitten") throw new Error(`${runtime}: "cat" found "${best}" by meaning, not "kitten"`)
  for (const pin of MEANING_ENGINES)
    if (!isEngineInstalled(pin, env)) throw new Error(`${runtime}: ${pin.name} is not in the empty data folder`)
  console.log(`dist (${runtime}): search by meaning installs its engines from npm and finds by meaning`)
}

/**
 * Voice from an empty data folder through cli-core's own loaders, so the engines come from npm and nowhere else: a
 * public-domain recording decoded by the Opus engine, then cut at its pauses by the speech engine's voice detector.
 */
const checkVoice = async (dist: string): Promise<void> => {
  const { decodeChannels } = await import(pathToFileURL(join(dist, "speech/decode.js")).href)
  const { openSpeechCutter, toModelRate } = await import(pathToFileURL(join(dist, "speech/recognize.js")).href)
  const engines = {
    env: { WIRECAT_STATE_DIR: scratch("core-dist-voice-") },
    progress: (line: string) => console.error(line),
  }
  const fixture = (name: string) => join(import.meta.dirname, "../src/testing/fixtures", name)
  const refusing = async () => {
    throw new Error("ffmpeg was asked: the Opus engine did not decode")
  }
  const { channels } = await decodeChannels(
    new Uint8Array(readFileSync(fixture("quiet-middle.ogg"))),
    refusing,
    engines,
  )
  const [channel] = channels
  if (channel?.rate !== 48_000 || channel.samples.length < 19 * 48_000)
    throw new Error(`${runtime}: the Opus engine did not decode the 20-second recording`)
  const cutter = await openSpeechCutter(fixture("silero_vad.onnx"), engines)
  let spans: { start: number; end: number }[]
  try {
    spans = cutter.cut(toModelRate(channel.samples, channel.rate))
  } finally {
    cutter.free()
  }
  if (spans.length < 2 || spans.some(({ start, end }) => !(end > start)))
    throw new Error(`${runtime}: the speech engine's voice detector found no speech: ${JSON.stringify(spans)}`)
  console.log(`dist (${runtime}): the pinned engines install from npm and load`)
  console.log(`dist (${runtime}): voice works from an empty data folder (${spans.length} stretches of speech)`)
}

// A `dist` other than this checkout's is an installed copy of the package: what npm, pnpm or Bun put on a machine.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await checkEngines(process.argv[2] ?? join(import.meta.dirname, "../dist"))
