import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { captureStreams, isCliError } from "@wirecat/cli-base"
import { describeProgram } from "@wirecat/cli-base/commands"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import { createProgram, run } from "../cli/program.js"
import type { Message } from "../domain/models.js"
import { engineFolder, installedEngines, isEngineInstalled, markerOf } from "../engines/install.js"
import { ENGINE_PINS } from "../engines/pins.js"
import { toolsFromCommands } from "../mcp/agent.js"
import type { SendGuard } from "../sends/guard.js"
import { storedDeps } from "../services/deps.js"
import { embeddingsService } from "../services/embeddings.js"
import { searchStore } from "../services/messages-archive-search.js"
import { meaningLane } from "../services/messages-meaning.js"
import type { Fetch } from "../speech/install.js"
import { type MessageStore, openStore } from "../store/store.js"
import { fakeRegistry, fixtureEngine } from "../testing/engine-fixtures.js"
import { sharedProgram } from "../testing/shared-program.js"
import { openEmbedder } from "./embed.js"
import { type EngineContext, installMeaningEngines, locateMeaningEngine, type MeaningFolders } from "./engine.js"
import type { TextModel } from "./models.js"

// Each tarball holds a package that re-exports the real devDependency, so what installs from this registry embeds.
const require = createRequire(import.meta.url)
const onnx = fixtureEngine("https://engines.test", "@wirecat/cli-core-onnx", "1.2.0", [
  {
    name: "@wirecat/cli-core-onnx",
    version: "1.2.0",
    files: [
      {
        path: "package/package.json",
        data: JSON.stringify({ name: "@wirecat/cli-core-onnx", type: "module", exports: { ".": "./index.js" } }),
      },
      {
        path: "package/index.js",
        data: `export * from ${JSON.stringify(pathToFileURL(require.resolve("@wirecat/cli-core-onnx")).href)}`,
      },
    ],
  },
])
const tokenizers = fixtureEngine("https://engines.test", "@huggingface/tokenizers", "0.2.0", [
  {
    name: "@huggingface/tokenizers",
    version: "0.2.0",
    files: [
      { path: "package/package.json", data: JSON.stringify({ name: "@huggingface/tokenizers", main: "index.js" }) },
      {
        path: "package/index.js",
        data: `module.exports = require(${JSON.stringify(require.resolve("@huggingface/tokenizers"))})`,
      },
    ],
  },
])
const bodies = new Map([...onnx.bodies, ...tokenizers.bodies])
const pins = [onnx.pin, tokenizers.pin] as const
const fromRegistry = (context: EngineContext) => installMeaningEngines(context, pins)

const tiny: TextModel = {
  id: "e5-small",
  title: "the tiny fixture under the default model's name",
  languages: "test",
  licence: "none",
  dims: 4,
  maxTokens: 64,
  chunksPerSecond: 1,
  pooling: "mean",
  prefix: { query: "", passage: "" },
  onnx: "onnx/model.onnx",
  files: [{ name: "onnx/model.onnx", url: "", sha256: "", bytes: 318 }],
}
vi.mock("./models.js", async (original) => {
  const real = await original<typeof import("./models.js")>()
  return { ...real, textModel: (id: string) => (id === "e5-small" ? tiny : real.textModel(id)) }
})

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url))
const root = fileURLToPath(new URL("../..", import.meta.url))
const fromDevDependencies = async (): Promise<MeaningFolders> => ({ onnx: root, tokenizers: root })
const offline: Fetch = async () => {
  throw new TypeError("fetch failed")
}

/** An empty WireCat data folder holding only the tiny model, as after `models download` of an older cli-core. */
const dataFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), "meaning-engine-"))
  mkdirSync(join(folder, "models", "text"), { recursive: true })
  symlinkSync(join(fixtures, "tiny"), join(folder, "models", "text", "e5-small"), "junction")
  return folder
}

const models = join(dataFolder(), "models", "text")

const rounded = (vector: Float32Array | undefined) => Array.from(vector ?? []).map((value) => value.toFixed(4))

const embedOnce = async (env: NodeJS.ProcessEnv, fetch: Fetch, progress?: (line: string) => void) => {
  const embedder = await openEmbedder(tiny, models, {
    threads: 1,
    engine: { env, fetch, retry: "chat models download e5-small", ...(progress ? { progress } : {}) },
  })
  try {
    return rounded((await embedder.embed(["cat"], "passage"))[0])
  } finally {
    await embedder.close()
  }
}
const TINY = await (async () => {
  locateMeaningEngine(fromDevDependencies)
  const embedder = await openEmbedder(tiny, models, { threads: 1 })
  try {
    return rounded((await embedder.embed(["cat"], "passage"))[0])
  } finally {
    await embedder.close()
  }
})()

const account = { provider: "test", account: "1" }
const stores: MessageStore[] = []
const message = (id: string, text: string): Message => ({
  id,
  chatId: "9",
  senderId: "100",
  senderName: null,
  timestamp: new Date(Date.parse("2026-10-01T00:00:00Z") + Number(id) * 3_600_000).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

/** Synthetic messages, with vectors built while the engines come from the devDependencies. */
const searchable = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "meaning-engine-store-")), "m.db") })
  stores.push(store)
  await store.chats.saveChats(account, [
    { id: "9", title: "Chat 9", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.messages.saveMessages(
    account,
    "9",
    [message("1", "cat dog"), message("2", "kitten"), message("3", "fish")],
    {
      via: "history",
    },
  )
  await store.searchIndex.fillSearchIndex({})
  await store.searchIndex.fillStems({})
  const deps = storedDeps({ provider: "test", app: { command: "chat" } } as Messenger, store, account, {} as SendGuard)
  return {
    embed: () => embeddingsService(deps).refresh({ threads: 1 }),
    discover: (text: string) =>
      searchStore(store, account, { text, discover: true, limit: 10, timezone: "UTC" }, {}, meaningLane(deps)),
  }
}

/** Every write to stdout and stderr while `work` runs: a search installing an engine must add none. */
const printed = async <T>(work: () => Promise<T>) => {
  const lines: string[] = []
  const keep = (chunk: unknown) => {
    lines.push(String(chunk))
    return true
  }
  const out = vi.spyOn(process.stdout, "write").mockImplementation(keep)
  const err = vi.spyOn(process.stderr, "write").mockImplementation(keep)
  try {
    return { result: await work(), lines }
  } finally {
    out.mockRestore()
    err.mockRestore()
  }
}

beforeEach(() => locateMeaningEngine(fromRegistry))
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  for (const store of stores.splice(0)) await store.close()
})

describe("search by meaning on the engine installer", () => {
  it("**the first search by meaning installs both engines into an empty data folder, quietly, and finds by meaning**", async () => {
    locateMeaningEngine(fromDevDependencies)
    const { embed, discover } = await searchable()
    vi.stubEnv("WIRECAT_STATE_DIR", dataFolder())
    expect((await embed()).messages).toEqual({ embedded: 3, left: 0 })
    locateMeaningEngine(fromRegistry)
    const folder = dataFolder()
    vi.stubEnv("WIRECAT_STATE_DIR", folder)
    const registry = fakeRegistry(bodies)
    vi.stubGlobal("fetch", registry.fetch)

    const { result: found, lines } = await printed(() => discover("cat"))

    expect(found.meaningSkipped).toBeUndefined()
    expect(new Map(found.items.map((hit) => [hit.id, hit.discovery?.foundBy])).get("2")).toEqual(["meaning"])
    expect(lines).toEqual([])
    const env = { WIRECAT_STATE_DIR: folder }
    for (const pin of pins) expect(isEngineInstalled(pin, env)).toBe(true)
    expect([...registry.requests.values()]).toEqual([1, 1])

    await discover("kitten")
    expect([...registry.requests.values()]).toEqual([1, 1])
  })

  it("**embeds the same vectors from the installed engines as from the packages beside cli-core**, progress to its line only", async () => {
    const env = { WIRECAT_STATE_DIR: dataFolder() }
    const progress: string[] = []

    expect(await embedOnce(env, fakeRegistry(bodies).fetch, (line) => progress.push(line))).toEqual(TINY)
    expect(TINY).toEqual(["1.0000", "0.0000", "0.0000", "0.0000"])
    expect(progress.join("\n")).toContain("installing @wirecat/cli-core-onnx 1.2.0")
    expect(progress.join("\n")).toContain("installing @huggingface/tokenizers 0.2.0")
  })

  it("**offline, the search still answers by words and names the command that installs the engine**", async () => {
    locateMeaningEngine(fromDevDependencies)
    const { embed, discover } = await searchable()
    vi.stubEnv("WIRECAT_STATE_DIR", dataFolder())
    await embed()
    locateMeaningEngine(fromRegistry)
    vi.stubEnv("WIRECAT_STATE_DIR", dataFolder())
    vi.stubGlobal("fetch", offline)

    const found = await discover("cat")

    expect(found.items.map(({ id }) => id)).toEqual(["1"])
    expect(found.meaningSkipped?.reason).toMatch(
      /^e5-small failed: search by meaning needs @wirecat\/cli-core-onnx 1\.2\.0, which could not be installed: .* — run the command again, or `chat models download e5-small`$/,
    )
  })

  it("**a missing engine is `not_found` with reason model.engine-missing**, which every word lane catches", async () => {
    const error = await openEmbedder(tiny, models, {
      engine: { env: { WIRECAT_STATE_DIR: dataFolder() }, fetch: offline, retry: "chat models download e5-small" },
    }).catch((caught: unknown) => caught)

    expect(isCliError(error) && error.code).toBe("not_found")
    expect(isCliError(error) && error.details).toMatchObject({
      reason: "model.engine-missing",
      engine: "@wirecat/cli-core-onnx",
      retry: "chat models download e5-small",
    })
  })

  it("**two loads at once install each engine once**; the second waits and uses it", async () => {
    const env = { WIRECAT_STATE_DIR: dataFolder() }
    const registry = fakeRegistry(bodies)

    expect(await Promise.all([embedOnce(env, registry.fetch), embedOnce(env, registry.fetch)])).toEqual([TINY, TINY])
    expect([...registry.requests.values()]).toEqual([1, 1])
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "**a data folder it cannot write is an error naming the folder**, and nothing is left in it",
    async () => {
      const folder = mkdtempSync(join(tmpdir(), "meaning-engine-readonly-"))
      chmodSync(folder, 0o500)
      try {
        await expect(embedOnce({ WIRECAT_STATE_DIR: folder }, fakeRegistry(bodies).fetch)).rejects.toThrow(
          `cannot write to ${join(folder, "engines")}`,
        )
        expect(readdirSync(folder)).toEqual([])
      } finally {
        chmodSync(folder, 0o700)
      }
    },
  )

  it("**an engine installed for another cli-core is installed again beside it, never loaded**", async () => {
    const env = { WIRECAT_STATE_DIR: dataFolder() }
    const older = join(env.WIRECAT_STATE_DIR, "engines", "@wirecat", "cli-core-onnx", "1.1.0", "0123456789ab")
    const stale = engineFolder(onnx.pin, env)
    for (const folder of [older, stale]) {
      mkdirSync(join(folder, "node_modules", "@wirecat", "cli-core-onnx"), { recursive: true })
      writeFileSync(
        join(folder, "engine.json"),
        JSON.stringify({ engine: onnx.pin.name, version: "1.1.0", packages: [] }),
      )
      writeFileSync(
        join(folder, "node_modules", "@wirecat", "cli-core-onnx", "package.json"),
        JSON.stringify({ name: onnx.pin.name, main: "index.js" }),
      )
      writeFileSync(join(folder, "node_modules", "@wirecat", "cli-core-onnx", "index.js"), "throw new Error('stale')")
    }

    expect(await embedOnce(env, fakeRegistry(bodies).fetch)).toEqual(TINY)
    expect(isEngineInstalled(onnx.pin, env)).toBe(true)
    expect(installedEngines({ [onnx.pin.name]: onnx.pin }, env).filter(({ name }) => name === onnx.pin.name)).toEqual([
      { name: onnx.pin.name, version: "1.1.0", path: older, current: false },
      { name: onnx.pin.name, version: "1.2.0", path: stale, current: true },
    ])
  })
})

describe("no command disappears without its engine", () => {
  /** Every engine cli-core pins, marked installed, as after each feature ran once. */
  const full = () => {
    const env = { WIRECAT_STATE_DIR: mkdtempSync(join(tmpdir(), "engines-full-")) }
    for (const pin of Object.values(ENGINE_PINS)) {
      mkdirSync(engineFolder(pin, env), { recursive: true })
      writeFileSync(join(engineFolder(pin, env), "engine.json"), markerOf(pin))
    }
    for (const pin of Object.values(ENGINE_PINS)) expect(isEngineInstalled(pin, env)).toBe(true)
    return env.WIRECAT_STATE_DIR
  }

  const surfaces = async (folder: string) => {
    vi.stubEnv("WIRECAT_STATE_DIR", folder)
    const env = { WIRECAT_STATE_DIR: folder, HOME: folder, CHAT_CONFIG_DIR: join(folder, "config") }
    const shown = async (argv: string[]) => {
      const streams = captureStreams()
      await run(argv, sharedProgram, { streams, env, tty: false })
      return streams.stdout.join("")
    }
    const described = describeProgram(createProgram(sharedProgram))
    return {
      help: await shown(["--help"]),
      commands: await shown(["commands", "--json"]),
      docs: JSON.stringify(described),
      tools: JSON.stringify(toolsFromCommands(described, { exclude: [["bot"]] })),
    }
  }

  it("**--help, commands, the generated docs and the MCP tools are the same with an empty data folder and a full one**", async () => {
    const empty = mkdtempSync(join(tmpdir(), "engines-empty-"))
    const before = await surfaces(empty)
    const after = await surfaces(full())

    expect(readdirSync(empty).includes("engines")).toBe(false)
    expect(before.commands.length).toBeGreaterThan(1_000)
    expect(JSON.parse(before.tools).map((tool: { command: string }) => tool.command)).toContain("search conversations")
    expect(after).toEqual(before)
  })
})

describe("the packages search by meaning runs on", () => {
  const sources = (folder: string): string[] =>
    readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) return entry.name === "testing" ? [] : sources(path)
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : []
    })

  it("**are loaded only through the engine installer**: no source imports them at run time", () => {
    const bare = /(?:from\s+|import\(\s*|require\(\s*)"(@wirecat\/cli-core-onnx|@huggingface\/tokenizers)"/
    const offenders = sources(join(root, "src")).filter((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .some((line) => bare.test(line) && !/^\s*(import|export) type\b/.test(line) && !/typeof import\(/.test(line)),
    )
    expect(offenders).toEqual([])
  })

  it("**are no dependency of the package**, only devDependencies the pins are read from", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
      string,
      Record<string, string>
    >
    for (const name of ["@wirecat/cli-core-onnx", "@huggingface/tokenizers", "onnxruntime-common"]) {
      expect(manifest.dependencies).not.toHaveProperty(name)
      expect(manifest.optionalDependencies ?? {}).not.toHaveProperty(name)
    }
    expect(manifest.devDependencies).toHaveProperty("@wirecat/cli-core-onnx")
    expect(manifest.devDependencies).toHaveProperty("@huggingface/tokenizers")
  })

  it("**have a package for Linux, macOS and Windows on x64 and arm64**", async () => {
    const { packagesFor } = await import("../engines/install.js")
    for (const platform of ["linux", "darwin", "win32"])
      for (const arch of ["x64", "arm64"])
        for (const name of ["@wirecat/cli-core-onnx", "@huggingface/tokenizers"] as const) {
          const target = { platform, arch, ...(platform === "linux" ? { libc: "glibc" as const } : {}) }
          expect(packagesFor(ENGINE_PINS[name], target).length, `${name} ${platform}-${arch}`).toBeGreaterThan(0)
        }
  })
})
