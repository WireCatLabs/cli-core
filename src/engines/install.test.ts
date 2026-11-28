import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { fakeRegistry, fixtureEngine, packageFiles } from "../testing/engine-fixtures.js"
import {
  type EnginePin,
  engineFolder,
  engineRequire,
  ensureEngine,
  importFromEngine,
  installedEngines,
  isEngineInstalled,
  packagesFor,
  type Target,
} from "./install.js"

const LINUX: Target = { platform: "linux", arch: "x64", libc: "glibc" }
const RETRY = "demo speech install"

const dataFolder = () => {
  const root = mkdtempSync(join(tmpdir(), "engines-"))
  return { root, env: { WIRECAT_STATE_DIR: root } }
}

const threePackages = (base = "https://registry.test") =>
  fixtureEngine(base, "demo-engine", "1.0.0", [
    { name: "demo-engine", version: "1.0.0", files: packageFiles("demo-engine", "1.0.0", "engine", "@demo/helper") },
    { name: "@demo/helper", version: "2.0.0", files: packageFiles("@demo/helper", "2.0.0", "helper") },
    { name: "demo-extra", version: "3.0.0", files: packageFiles("demo-extra", "3.0.0", "extra") },
  ])

const leftovers = (pin: EnginePin, env: NodeJS.ProcessEnv) => {
  const parent = dirname(engineFolder(pin, env, LINUX))
  return existsSync(parent) ? readdirSync(parent).filter((entry) => !entry.endsWith(".lock")) : []
}

const install = (pin: EnginePin, env: NodeJS.ProcessEnv, fetch: ReturnType<typeof fakeRegistry>["fetch"]) =>
  ensureEngine(pin, { retry: RETRY, env, fetch, target: LINUX })

describe("ensureEngine", () => {
  it("**installs an engine into an empty data folder on first use, then loads it from there**", async () => {
    const { root, env } = dataFolder()
    const { pin, bodies } = threePackages()
    const registry = fakeRegistry(bodies)
    const lines: string[] = []

    const state = await ensureEngine(pin, {
      retry: RETRY,
      env,
      fetch: registry.fetch,
      target: LINUX,
      progress: (line) => lines.push(line),
    })

    const folder = join(root, "engines", "demo-engine", "1.0.0", basename(engineFolder(pin, {}, LINUX)))
    expect(state).toEqual({ status: "ready", engine: "demo-engine", version: "1.0.0", folder, installed: true })
    expect(engineRequire(folder)("demo-engine")).toEqual({ answer: "engine", needs: "helper" })
    expect(await importFromEngine(folder, "demo-extra")).toMatchObject({ default: { answer: "extra" } })
    expect(lines[0]).toContain(`installing demo-engine 1.0.0`)
    expect(leftovers(pin, env)).toEqual([basename(folder)])

    expect(await install(pin, env, registry.fetch)).toMatchObject({ status: "ready", installed: false })
    expect([...registry.requests.values()]).toEqual([1, 1, 1])
  })

  it("**loads the engine's own copy of a package, never the one installed beside cli-core**", async () => {
    const { env } = dataFolder()
    const { pin, bodies } = fixtureEngine("https://registry.test", "fflate", "0.0.1", [
      { name: "fflate", version: "0.0.1", files: packageFiles("fflate", "0.0.1", "the engine's own") },
    ])
    const state = await install(pin, env, fakeRegistry(bodies).fetch)
    if (state.status !== "ready") throw new Error(state.reason)
    expect(engineRequire(state.folder)("fflate")).toEqual({ answer: "the engine's own" })
  })

  it("**never runs a package's scripts**", async () => {
    const { root, env } = dataFolder()
    const ran = join(root, "postinstall-ran")
    const script = `require("fs").writeFileSync(${JSON.stringify(ran)}, "")`
    const { pin, bodies } = fixtureEngine("https://registry.test", "scripted", "1.0.0", [
      {
        name: "scripted",
        version: "1.0.0",
        files: [
          {
            path: "package/package.json",
            data: JSON.stringify({
              name: "scripted",
              version: "1.0.0",
              scripts: { preinstall: script, install: script, postinstall: script },
            }),
          },
          { path: "package/index.js", data: "module.exports = 1" },
        ],
      },
    ])
    expect(await install(pin, env, fakeRegistry(bodies).fetch)).toMatchObject({ status: "ready" })
    expect(existsSync(ran)).toBe(false)
  })

  it("**refuses a file whose hash is wrong, and installs nothing**", async () => {
    const { env } = dataFolder()
    const { pin, bodies } = threePackages()
    const second = pin.packages[1]?.url as string
    bodies.set(
      second,
      (bodies.get(second) as Uint8Array).map((byte, index) => (index === 20 ? byte ^ 1 : byte)),
    )

    const state = await install(pin, env, fakeRegistry(bodies).fetch)

    expect(state).toMatchObject({ status: "engine-missing", engine: "demo-engine", retry: RETRY })
    expect(state.status === "engine-missing" && state.reason).toContain("is not the file this version expects")
    expect(isEngineInstalled(pin, env, LINUX)).toBe(false)
    expect(leftovers(pin, env)).toEqual([])
  })

  it("**offline: engine-missing with the exact command to retry, and the next run installs**", async () => {
    const { env } = dataFolder()
    const { pin, bodies } = threePackages()
    const offline = async () => {
      throw new TypeError("fetch failed")
    }

    expect(await ensureEngine(pin, { retry: RETRY, env, fetch: offline, target: LINUX })).toEqual({
      status: "engine-missing",
      engine: "demo-engine",
      version: "1.0.0",
      reason: "fetch failed",
      retry: RETRY,
    })
    expect(leftovers(pin, env)).toEqual([])
    expect(await install(pin, env, fakeRegistry(bodies).fetch)).toMatchObject({ status: "ready", installed: true })
  })

  it("**a download cut halfway leaves nothing half-written**", async () => {
    const { env } = dataFolder()
    const { pin, bodies } = threePackages()
    const registry = fakeRegistry(bodies)
    const third = pin.packages[2]?.url as string
    const cut = async (url: string) => {
      if (url !== third) return registry.fetch(url)
      const body = bodies.get(url) as Uint8Array
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(body.slice(0, 10))
            controller.error(new Error("connection reset"))
          },
        }),
      )
    }

    expect(await ensureEngine(pin, { retry: RETRY, env, fetch: cut, target: LINUX })).toMatchObject({
      status: "engine-missing",
      reason: "connection reset",
    })
    expect(leftovers(pin, env)).toEqual([])
  })

  it("**a staging folder left by a killed install is never loaded, and the next install clears it**", async () => {
    const { env } = dataFolder()
    const { pin, bodies } = threePackages()
    const parent = dirname(engineFolder(pin, env, LINUX))
    mkdirSync(join(parent, ".staging-killed", "node_modules", "demo-engine"), { recursive: true })
    writeFileSync(join(parent, ".staging-killed", "node_modules", "demo-engine", "index.js"), "half")

    expect(isEngineInstalled(pin, env, LINUX)).toBe(false)
    expect(installedEngines({}, env, LINUX)).toEqual([])
    expect(await install(pin, env, fakeRegistry(bodies).fetch)).toMatchObject({ status: "ready", installed: true })
    expect(leftovers(pin, env)).toEqual([basename(engineFolder(pin, env, LINUX))])
  })

  it("**an engine installed for an older cli-core is told by its version and packages, installed again, never loaded**", async () => {
    const { env } = dataFolder()
    const older = fixtureEngine("https://registry.test", "demo-engine", "0.9.0", [
      { name: "demo-engine", version: "0.9.0", files: packageFiles("demo-engine", "0.9.0", "older") },
    ])
    const sameVersionOtherFiles = fixtureEngine("https://registry.test", "demo-engine", "1.0.0", [
      { name: "demo-engine", version: "1.0.0", files: packageFiles("demo-engine", "1.0.0", "rebuilt") },
    ])
    const { pin, bodies } = threePackages()
    await install(older.pin, env, fakeRegistry(older.bodies).fetch)
    await install(sameVersionOtherFiles.pin, env, fakeRegistry(sameVersionOtherFiles.bodies).fetch)

    expect(isEngineInstalled(pin, env, LINUX)).toBe(false)
    const state = await install(pin, env, fakeRegistry(bodies).fetch)

    expect(state).toMatchObject({ status: "ready", installed: true })
    expect(engineRequire(engineFolder(pin, env, LINUX))("demo-engine")).toEqual({ answer: "engine", needs: "helper" })
    const rebuilt = engineFolder(sameVersionOtherFiles.pin, env, LINUX)
    expect(rebuilt).not.toBe(engineFolder(pin, env, LINUX))
    expect(engineRequire(rebuilt)("demo-engine")).toEqual({ answer: "rebuilt" })
    expect(installedEngines({ "demo-engine": pin }, env, LINUX)).toEqual([
      { name: "demo-engine", version: "0.9.0", path: engineFolder(older.pin, env, LINUX), current: false },
      ...[
        { name: "demo-engine", version: "1.0.0", path: rebuilt, current: false },
        { name: "demo-engine", version: "1.0.0", path: engineFolder(pin, env, LINUX), current: true },
      ].sort((a, b) => a.path.localeCompare(b.path)),
    ])
  })

  it("**two installs of one engine at once: one downloads, the other waits and uses it**", async () => {
    const { env } = dataFolder()
    const { pin, bodies } = threePackages()
    const registry = fakeRegistry(bodies)
    const waits: string[] = []
    let waiting = () => {}
    const secondWaits = new Promise<void>((resolve) => {
      waiting = resolve
    })
    const options = {
      retry: RETRY,
      env,
      target: LINUX,
      sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
    }

    const first = ensureEngine(pin, {
      ...options,
      fetch: async (url) => {
        await secondWaits
        return registry.fetch(url)
      },
    })
    const second = ensureEngine(pin, {
      ...options,
      fetch: registry.fetch,
      progress: (line) => {
        waits.push(line)
        waiting()
      },
    })

    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ status: "ready", installed: true }),
      expect.objectContaining({ status: "ready", installed: false }),
    ])
    expect(waits).toEqual(["demo-engine 1.0.0 is being installed by another process; waiting for it"])
    expect([...registry.requests.values()]).toEqual([1, 1, 1])
  })

  it("**gives up waiting on another process's install after the limit, with the command to retry**", async () => {
    const { env } = dataFolder()
    const { pin, bodies } = threePackages()
    const { acquireLock } = await import("../files/lock.js")
    const lock = await acquireLock(`${engineFolder(pin, env, LINUX)}.lock`)
    try {
      expect(
        await ensureEngine(pin, { retry: RETRY, env, fetch: fakeRegistry(bodies).fetch, target: LINUX, lockWaitMs: 0 }),
      ).toMatchObject({ status: "engine-missing", retry: RETRY, reason: expect.stringContaining("another process") })
    } finally {
      await lock.release()
    }
  })

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "**no write access to the data folder: an error naming the folder, nothing written** (POSIX permissions)",
    async () => {
      const { root, env } = dataFolder()
      const { pin, bodies } = threePackages()
      chmodSync(root, 0o500)
      try {
        const state = await install(pin, env, fakeRegistry(bodies).fetch)
        expect(state).toMatchObject({ status: "engine-missing", retry: RETRY })
        expect(state.status === "engine-missing" && state.reason).toContain(`cannot write to ${join(root, "engines")}`)
        expect(readdirSync(root)).toEqual([])
      } finally {
        chmodSync(root, 0o700)
      }
    },
  )

  for (const [what, entry] of [
    ["a symbolic link", { path: "package/link", type: "2" as const }],
    ["a path out of its folder", { path: "package/../../escaped.js", data: "x" }],
  ] as const)
    it(`**refuses a package holding ${what}, and installs nothing**`, async () => {
      const { root, env } = dataFolder()
      const { pin, bodies } = fixtureEngine("https://registry.test", "sly", "1.0.0", [
        { name: "sly", version: "1.0.0", files: [...packageFiles("sly", "1.0.0", "x"), entry] },
      ])
      const state = await install(pin, env, fakeRegistry(bodies).fetch)
      expect(state).toMatchObject({ status: "engine-missing", reason: expect.stringContaining("outside its folder") })
      expect(leftovers(pin, env)).toEqual([])
      expect(existsSync(join(root, "escaped.js"))).toBe(false)
    })
})

describe("one package per system", () => {
  const { pin, bodies } = fixtureEngine("https://registry.test", "native-engine", "2.0.3", [
    { name: "native-engine", version: "2.0.3", files: packageFiles("native-engine", "2.0.3", "wrapper") },
    ...(
      [
        ["linux", "x64"],
        ["linux", "arm64"],
        ["darwin", "arm64"],
        ["win32", "x64"],
      ] as const
    ).map(([os, cpu]) => ({
      name: `native-engine-${os}-${cpu}`,
      version: "2.0.3",
      os: [os],
      cpu: [cpu],
      files: packageFiles(`native-engine-${os}-${cpu}`, "2.0.3", `${os}-${cpu}`),
    })),
  ])

  it("**picks the wrapper and this system's own package, by npm's os and cpu rules**", () => {
    const names = (target: Target) => packagesFor(pin, target).map((pkg) => pkg.name)
    expect(names(LINUX)).toEqual(["native-engine", "native-engine-linux-x64"])
    expect(names({ platform: "darwin", arch: "arm64" })).toEqual(["native-engine", "native-engine-darwin-arm64"])
    expect(names({ platform: "win32", arch: "x64" })).toEqual(["native-engine", "native-engine-win32-x64"])
    expect(names({ platform: "freebsd", arch: "x64" })).toEqual(["native-engine"])
    const musl = { ...pin, packages: [{ ...(pin.packages[1] as EnginePin["packages"][number]), libc: ["!musl"] }] }
    expect(packagesFor(musl, { ...LINUX, libc: "musl" })).toEqual([])
  })

  it("**downloads only this system's package, and installs again for another system**", async () => {
    const { env } = dataFolder()
    const registry = fakeRegistry(bodies)
    await install(pin, env, registry.fetch)
    expect([...registry.requests.keys()].map((url) => url.split("/").pop())).toEqual([
      "native-engine-2.0.3.tgz",
      "native-engine-linux-x64-2.0.3.tgz",
    ])
    const marker = JSON.parse(readFileSync(join(engineFolder(pin, env, LINUX), "engine.json"), "utf8"))
    expect(marker.packages.map((pkg: { name: string }) => pkg.name)).toEqual([
      "native-engine",
      "native-engine-linux-x64",
    ])

    const arm = { platform: "linux", arch: "arm64", libc: "glibc" } as const
    expect(isEngineInstalled(pin, env, arm)).toBe(false)
    expect(await ensureEngine(pin, { retry: RETRY, env, fetch: registry.fetch, target: arm })).toMatchObject({
      status: "ready",
      installed: true,
    })
    expect(engineRequire(engineFolder(pin, env, arm))("native-engine-linux-arm64")).toEqual({ answer: "linux-arm64" })
    expect(isEngineInstalled(pin, env, LINUX)).toBe(true)
  })

  it("**refuses a system it has no package for**", async () => {
    const { env } = dataFolder()
    const only = { ...pin, packages: pin.packages.slice(1, 2) }
    expect(
      await ensureEngine(only, {
        retry: RETRY,
        env,
        fetch: fakeRegistry(bodies).fetch,
        target: { platform: "aix", arch: "ppc64" },
      }),
    ).toMatchObject({ status: "engine-missing", reason: "native-engine has no package for aix-ppc64" })
  })
})
