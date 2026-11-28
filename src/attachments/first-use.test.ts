import { chmodSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type EnginePin, engineFolder, ensureEngine } from "../engines/install.js"
import { ENGINE_PINS } from "../engines/pins.js"
import type { Fetch } from "../speech/install.js"
import { fakeRegistry, fixtureEngine, type TarFile } from "../testing/engine-fixtures.js"
import { engineLoader, engineStates, extractText } from "./extract.js"

const RETRY = "the same command, once this computer can reach registry.npmjs.org"

const manifest = (name: string, version: string, extra: object = {}): TarFile => ({
  path: "package/package.json",
  data: JSON.stringify({ name, version, ...extra }),
})

/**
 * An engine shaped like defuddle's: `defuddle/node` exported for `import` only, `linkedom` beside it, and linkedom
 * needing a second version of `entities`, nested under it.
 */
const readerEngine = (version = "1.0.0") =>
  fixtureEngine("https://registry.test", "defuddle", version, [
    {
      name: "defuddle",
      version,
      files: [
        manifest("defuddle", version, { type: "module", exports: { "./node": { import: "./node.js" } } }),
        {
          path: "package/node.js",
          data: `import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
export const answer = "defuddle ${version} with " + require("linkedom").answer`,
        },
      ],
    },
    {
      name: "linkedom",
      version: "1.0.0",
      files: [
        manifest("linkedom", "1.0.0", { main: "index.js" }),
        { path: "package/index.js", data: `module.exports = { answer: "entities " + require("entities").answer }` },
      ],
    },
    {
      name: "entities",
      version: "1.0.0",
      files: [
        manifest("entities", "1.0.0", { main: "index.js" }),
        { path: "package/index.js", data: `module.exports = { answer: "1" }` },
      ],
    },
    {
      name: "entities",
      version: "2.0.0",
      path: "linkedom/node_modules/entities",
      files: [
        manifest("entities", "2.0.0", { main: "index.js" }),
        { path: "package/index.js", data: `module.exports = { answer: "2" }` },
      ],
    },
  ])

const dataFolder = () => {
  const root = mkdtempSync(join(tmpdir(), "first-use-"))
  return { root, env: { WIRECAT_STATE_DIR: root } }
}

const offline: Fetch = async () => {
  throw new TypeError("fetch failed")
}

const hint = (name: string, mime: string) => ({ kind: "file", name, mime, path: `/saved/${name}` })
const bytes = (text: string) => new TextEncoder().encode(text)
const PAGE = "<html><head><title>Notes</title></head><body><p>Hello</p></body></html>"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("a reader installed on first use", () => {
  it("**installs with no question and prints nothing, once for both its packages, and loads from the data folder**", async () => {
    const { env } = dataFolder()
    const { pin, bodies } = readerEngine()
    const registry = fakeRegistry(bodies)
    const stdout = vi.spyOn(process.stdout, "write")
    const stderr = vi.spyOn(process.stderr, "write")
    const load = engineLoader({ env, fetch: registry.fetch, pins: { defuddle: pin } })

    const [page, dom] = (await Promise.all([load("defuddle/node"), load("linkedom")])) as { answer: string }[]

    expect(page?.answer).toBe("defuddle 1.0.0 with entities 2")
    expect(dom?.answer).toBe("entities 2")
    expect([...registry.requests.values()]).toEqual([1, 1, 1, 1])
    expect(stdout).not.toHaveBeenCalled()
    expect(stderr).not.toHaveBeenCalled()
  })

  it("**offline: engine-missing with the command to retry, and the rest of the run still reads**", async () => {
    const { env } = dataFolder()
    const load = engineLoader({ env, fetch: offline, pins: { ...ENGINE_PINS, defuddle: readerEngine().pin } })

    expect(await extractText(bytes(PAGE), hint("page.html", "text/html"), load)).toEqual({
      status: "engine-missing",
      engine: "linkedom",
      retry: RETRY,
      reason: "fetch failed",
    })
    expect(await extractText(bytes("%PDF-1.7\n"), hint("report.pdf", "application/pdf"), load)).toEqual({
      status: "engine-missing",
      engine: "unpdf",
      retry: RETRY,
      reason: "fetch failed",
    })
    expect(await extractText(bytes("plain words"), hint("notes.txt", "text/plain"), load)).toMatchObject({
      status: "extracted",
      text: "plain words",
    })
    expect(engineStates(undefined, env)).toMatchObject({ unpdf: "on first use", "defuddle/node": "on first use" })
  })

  it("**an engine an older cli-core installed is never loaded: this one's version is installed beside it**", async () => {
    const { env } = dataFolder()
    const older = readerEngine("0.9.0")
    await ensureEngine(older.pin, { retry: RETRY, env, fetch: fakeRegistry(older.bodies).fetch })
    const { pin, bodies } = readerEngine("1.0.0")

    const page = (await engineLoader({ env, fetch: fakeRegistry(bodies).fetch, pins: { defuddle: pin } })(
      "defuddle/node",
    )) as { answer: string }

    expect(page.answer).toBe("defuddle 1.0.0 with entities 2")
    expect(engineFolder(pin as EnginePin, env)).not.toBe(engineFolder(older.pin, env))
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "**no write access to the data folder: engine-missing naming the folder, nothing written** (POSIX permissions)",
    async () => {
      const { root, env } = dataFolder()
      const { pin, bodies } = readerEngine()
      chmodSync(root, 0o500)
      try {
        const read = await extractText(
          bytes(PAGE),
          hint("page.html", "text/html"),
          engineLoader({ env, fetch: fakeRegistry(bodies).fetch, pins: { defuddle: pin } }),
        )
        expect(read).toMatchObject({ status: "engine-missing", engine: "linkedom", retry: RETRY })
        expect(read.status === "engine-missing" && read.reason).toContain(`cannot write to ${join(root, "engines")}`)
        expect(readdirSync(root)).toEqual([])
      } finally {
        chmodSync(root, 0o700)
      }
    },
  )
})
