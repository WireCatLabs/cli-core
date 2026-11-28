import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { fixtureEngine, packageFiles, serveRegistry } from "../src/testing/engine-fixtures.ts"
import { scratch } from "./scratch.ts"

const runtime = typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? "node" : "bun"

/**
 * The built installer, from an empty data folder, under whichever runtime runs this: a test engine from a registry on
 * 127.0.0.1 always, and with `ENGINE_CHECK_REAL=1` the engines cli-core pins, from npm.
 */
export const checkEngines = async (dist: string): Promise<void> => {
  const { ensureEngine, engineFolder, engineRequire, importFromEngine } = await import(
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
  const { ENGINE_PINS } = await import(pathToFileURL(join(dist, "engines/pins.js")).href)
  const env = { WIRECAT_STATE_DIR: scratch("core-dist-real-engines-") }
  for (const pin of Object.values(ENGINE_PINS) as { name: string }[]) {
    const state = await ensureEngine(pin, { retry: "check", env, progress: (line: string) => console.error(line) })
    if (state.status !== "ready") throw new Error(`${runtime}: ${pin.name}: ${state.reason}`)
  }
  const sherpa = engineRequire(engineFolder(ENGINE_PINS["sherpa-onnx"], env))("sherpa-onnx/sherpa-onnx-asr.js")
  const opus = await importFromEngine(engineFolder(ENGINE_PINS["ogg-opus-decoder"], env), "ogg-opus-decoder")
  if (typeof sherpa.OfflineRecognizer !== "function" || typeof opus.OggOpusDecoder !== "function")
    throw new Error(`${runtime}: the pinned engines did not load from the data folder`)
  console.log(`dist (${runtime}): the pinned engines install from npm and load`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await checkEngines(join(import.meta.dirname, "../dist"))
