import { type ChildProcess, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { fixtureEngine, packageFiles, serveRegistry } from "../testing/engine-fixtures.js"
import { type EnginePin, engineFolder, engineRequire, ensureEngine, isEngineInstalled } from "./install.js"

const files = new Map<string, Uint8Array>()
let registry: Awaited<ReturnType<typeof serveRegistry>>
let module: string

beforeAll(async () => {
  registry = await serveRegistry(files)
  module = join(mkdtempSync(join(tmpdir(), "engines-process-")), "install.mjs")
  await build({
    entryPoints: [fileURLToPath(new URL("./install.ts", import.meta.url))],
    outfile: module,
    bundle: true,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "packages-from-this-checkout",
        setup(builder) {
          // A Windows entry point (D:\…) also starts with neither a dot nor a slash.
          builder.onResolve({ filter: /^[^./]/ }, (args) =>
            args.kind === "entry-point" || isAbsolute(args.path)
              ? undefined
              : { path: import.meta.resolve(args.path), external: true },
          )
        },
      },
    ],
  })
})

afterAll(() => new Promise<void>((resolve) => registry.server.close(() => resolve())))

const engine = (version: string) => {
  const { pin, bodies } = fixtureEngine(registry.base, "process-engine", version, [
    { name: "process-engine", version, files: packageFiles("process-engine", version, "engine", "process-helper") },
    { name: "process-helper", version, files: packageFiles("process-helper", version, "helper") },
  ])
  for (const [url, body] of bodies) files.set(new URL(url).pathname, body)
  return pin
}

/** A separate process, as a second CLI is: it installs and loads the engine, and prints what it got as JSON. */
const installer = (pin: EnginePin, root: string): ChildProcess => {
  const program = `
    const { ensureEngine, engineRequire } = await import(${JSON.stringify(pathToFileURL(module).href)});
    const state = await ensureEngine(${JSON.stringify(pin)}, {
      retry: "demo speech install",
      env: { WIRECAT_STATE_DIR: ${JSON.stringify(root)} },
      lockPollMs: 20,
      progress: (line) => process.stderr.write(line + "\\n"),
    });
    const loaded = state.status === "ready" ? engineRequire(state.folder)("process-engine") : null;
    process.stdout.write(JSON.stringify({ state, loaded }));
  `
  return spawn(process.execPath, ["--input-type=module", "--eval", program], {
    env: { ...process.env, HOME: root, USERPROFILE: root, WIRECAT_STATE_DIR: root },
    stdio: ["ignore", "pipe", "pipe"],
  })
}

const outputOf = async (child: ChildProcess) => {
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk) => {
    stdout += chunk
  })
  child.stderr?.on("data", (chunk) => {
    stderr += chunk
  })
  const [code] = await once(child, "exit")
  return { code, stderr, ...(JSON.parse(stdout || "null") as { state: { status: string; installed?: boolean } }) }
}

const until = async (condition: () => boolean, what: string) => {
  for (let tries = 0; !condition(); tries += 1) {
    if (tries > 500) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const stderrOf = (child: ChildProcess) => {
  const lines: string[] = []
  child.stderr?.on("data", (chunk) => lines.push(String(chunk)))
  return lines
}

describe("installing in two processes", () => {
  it("**two processes installing one engine at once: one installs, the other waits and uses it**", async () => {
    const root = mkdtempSync(join(tmpdir(), "engines-two-"))
    const pin = engine("1.0.0")
    const first = pin.packages[0]?.url as string
    registry.hold.add(new URL(first).pathname)

    const a = installer(pin, root)
    const aDone = outputOf(a)
    await until(() => registry.requests.has(new URL(first).pathname), "the first download")
    const b = installer(pin, root)
    const bSays = stderrOf(b)
    const bDone = outputOf(b)
    await until(() => bSays.join("").includes("waiting for it"), "the second process to wait")
    registry.hold.clear()
    registry.release()

    const results = await Promise.all([aDone, bDone])
    expect(results.map(({ code, state }) => [code, state.status, state.installed])).toEqual([
      [0, "ready", true],
      [0, "ready", false],
    ])
    expect(results.map((result) => (result as { loaded?: unknown }).loaded)).toEqual([
      { answer: "engine", needs: "helper" },
      { answer: "engine", needs: "helper" },
    ])
    expect(pin.packages.map((pkg) => registry.requests.get(new URL(pkg.url).pathname))).toEqual([1, 1])
  })

  it("**an install killed halfway leaves nothing loadable, and the next one completes**", async () => {
    const root = mkdtempSync(join(tmpdir(), "engines-killed-"))
    const env = { WIRECAT_STATE_DIR: root }
    const pin = engine("2.0.0")
    const second = new URL(pin.packages[1]?.url as string).pathname
    registry.hold.add(second)

    const child = installer(pin, root)
    const exited = once(child, "exit")
    await until(() => registry.requests.has(second), "the second download")
    child.kill("SIGKILL")
    await exited
    registry.hold.clear()
    registry.release()

    expect(isEngineInstalled(pin, env)).toBe(false)
    expect(readdirSync(dirname(engineFolder(pin, env))).filter((entry) => !entry.endsWith(".lock"))).toEqual([
      expect.stringMatching(/^\.staging-/),
    ])
    const state = await ensureEngine(pin, { retry: "demo speech install", env, lockWaitMs: 1000 })
    expect(state).toMatchObject({ status: "ready", installed: true })
    expect(engineRequire(engineFolder(pin, env))("process-engine")).toEqual({ answer: "engine", needs: "helper" })
    expect(readdirSync(dirname(engineFolder(pin, env))).filter((entry) => !entry.endsWith(".lock"))).toEqual([
      basename(engineFolder(pin, env)),
    ])
  })
})
