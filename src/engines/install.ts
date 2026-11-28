import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { CliError, isCliError } from "@wirecat/cli-base"
import { gunzipSync } from "fflate"
import { onMusl } from "../embeddings/onnx-runtime.js"
import { acquireLock, type FileLock } from "../files/lock.js"
import { tarEntries } from "../files/tar.js"
import { type Fetch, installFiles, megabytes } from "../speech/install.js"
import { wirecatDirectory } from "../store/path.js"

/** One npm package of an engine, as `scripts/engine-pins.ts` read it from the lockfile and the registry. */
export interface EnginePackage {
  readonly name: string
  readonly version: string
  readonly url: string
  /** The registry's `dist.integrity` (sha512), never written by hand. */
  readonly integrity: string
  /** The tarball's size, so a download that runs past it stops. */
  readonly bytes: number
  /** npm's own fields: a package for some systems only, such as `sherpa-onnx-linux-x64`. */
  readonly os?: readonly string[]
  readonly cpu?: readonly string[]
  readonly libc?: readonly string[]
}

/** An engine is a package and everything it needs, installed into the WireCat data folder on first use. */
export interface EnginePin {
  readonly name: string
  readonly version: string
  readonly packages: readonly EnginePackage[]
}

export interface Target {
  platform: string
  arch: string
  libc?: "glibc" | "musl"
}

export type EngineState =
  | { status: "ready"; engine: string; version: string; folder: string; installed: boolean }
  | { status: "engine-missing"; engine: string; version: string; reason: string; retry: string }

export type EngineMissing = Extract<EngineState, { status: "engine-missing" }>

/** What a loader throws when its engine could not be installed, so a reader reports `engine-missing`, not a crash. */
export class EngineUnavailable extends Error {
  constructor(readonly state: EngineMissing) {
    super(state.reason)
  }
}

export interface EnsureOptions {
  /** The command a person runs to try again, such as `max speech install`. */
  retry: string
  env?: NodeJS.ProcessEnv
  fetch?: Fetch
  /** Lines for a person; the CLI passes one only when they go to stderr and nobody parses them. */
  progress?: (line: string) => void
  target?: Target
  lockPollMs?: number
  /** How long to wait for another process's install of the same engine before giving up on it. */
  lockWaitMs?: number
  sleep?: (ms: number) => Promise<void>
}

const MARKER = "engine.json"
const LOCK_POLL_MS = 250
const LOCK_WAIT_MS = 15 * 60_000

export const enginesDirectory = (env: NodeJS.ProcessEnv = process.env): string => join(wirecatDirectory(env), "engines")

const versionFolder = (pin: Pick<EnginePin, "name" | "version">, env: NodeJS.ProcessEnv) =>
  join(enginesDirectory(env), ...pin.name.split("/"), pin.version)

/**
 * `engines/<name>/<version>/<key>`, the key a hash of the packages this system gets. A placed folder never changes:
 * another cli-core pinning other tarballs of the same version, or Node of the other CPU on one Mac, gets its own,
 * so nothing a running process loaded is ever replaced under it.
 */
export const engineFolder = (
  pin: EnginePin,
  env: NodeJS.ProcessEnv = process.env,
  target: Target = currentTarget(),
): string => join(versionFolder(pin, env), keyOf(markerOf(pin, target)))

const keyOf = (marker: string) => createHash("sha256").update(marker).digest("hex").slice(0, 12)

export const currentTarget = (): Target => ({
  platform: process.platform,
  arch: process.arch,
  ...(process.platform === "linux" ? { libc: onMusl() ? ("musl" as const) : ("glibc" as const) } : {}),
})

/** npm's rule for `os`, `cpu` and `libc`: `!name` excludes, any plain name limits to the names listed. */
const fits = (list: readonly string[] | undefined, value: string | undefined): boolean => {
  if (!list || list.length === 0) return true
  if (value === undefined) return false
  const allowed = list.filter((entry) => !entry.startsWith("!"))
  return !list.includes(`!${value}`) && (allowed.length === 0 || allowed.includes(value))
}

export const packagesFor = (pin: EnginePin, target: Target = currentTarget()): EnginePackage[] =>
  pin.packages.filter(
    (pkg) => fits(pkg.os, target.platform) && fits(pkg.cpu, target.arch) && fits(pkg.libc, target.libc),
  )

/** What the marker of a usable install says, written last: a folder without it is not loaded. */
const markerOf = (pin: EnginePin, target: Target) =>
  JSON.stringify({
    engine: pin.name,
    version: pin.version,
    packages: packagesFor(pin, target).map(({ name, version, integrity }) => ({ name, version, integrity })),
  })

const readMarker = (folder: string): string | undefined => {
  try {
    return JSON.stringify(JSON.parse(readFileSync(join(folder, MARKER), "utf8")))
  } catch {
    return undefined
  }
}

export const isEngineInstalled = (
  pin: EnginePin,
  env: NodeJS.ProcessEnv = process.env,
  target: Target = currentTarget(),
): boolean => readMarker(engineFolder(pin, env, target)) === markerOf(pin, target)

/** `require` as the engine's own folder sees it: its packages, never the ones beside cli-core. */
export const engineRequire = (folder: string): NodeJS.Require => createRequire(join(folder, MARKER))

export const importFromEngine = async <T = unknown>(folder: string, specifier: string): Promise<T> =>
  (await import(pathToFileURL(engineRequire(folder).resolve(specifier)).href)) as T

/**
 * The engine installed and ready to load, installing it first when it is not: no question asked. A failure of any
 * kind is an `engine-missing` state with the reason and the command to try again, never a throw, so the command that
 * asked still does the rest of its work.
 */
export const ensureEngine = async (pin: EnginePin, options: EnsureOptions): Promise<EngineState> => {
  const env = options.env ?? process.env
  const target = options.target ?? currentTarget()
  const folder = engineFolder(pin, env, target)
  const ready = (installed: boolean): EngineState => ({
    status: "ready",
    engine: pin.name,
    version: pin.version,
    folder,
    installed,
  })
  const missing = (reason: string): EngineState => ({
    status: "engine-missing",
    engine: pin.name,
    version: pin.version,
    reason,
    retry: options.retry,
  })
  if (isEngineInstalled(pin, env, target)) return ready(false)
  try {
    const lock = await waitForLock(pin, env, target, options)
    if (lock === "installed") return ready(false)
    if (lock === undefined)
      return missing(`another process has been installing ${pin.name} for over ${minutes(options)} — try again later`)
    try {
      if (isEngineInstalled(pin, env, target)) return ready(false)
      await place(pin, folder, target, options)
      return ready(true)
    } finally {
      await lock.release().catch(() => {})
    }
  } catch (error) {
    return missing(reasonOf(error, enginesDirectory(env)))
  }
}

const minutes = (options: EnsureOptions) => `${Math.round((options.lockWaitMs ?? LOCK_WAIT_MS) / 60_000)} min`

const lockPath = (pin: EnginePin, env: NodeJS.ProcessEnv, target: Target) => `${engineFolder(pin, env, target)}.lock`

const waitForLock = async (
  pin: EnginePin,
  env: NodeJS.ProcessEnv,
  target: Target,
  options: EnsureOptions,
): Promise<FileLock | "installed" | undefined> => {
  const poll = options.lockPollMs ?? LOCK_POLL_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let told = false
  for (let waited = 0; ; waited += poll) {
    try {
      return await acquireLock(lockPath(pin, env, target))
    } catch (error) {
      if (!(isCliError(error) && error.details.reason === "file.locked")) throw error
    }
    if (isEngineInstalled(pin, env, target)) return "installed"
    if (waited >= (options.lockWaitMs ?? LOCK_WAIT_MS)) return undefined
    if (!told) options.progress?.(`${pin.name} ${pin.version} is being installed by another process; waiting for it`)
    told = true
    // Two that tried at the same instant both see the other and both back off; unequal pauses part them.
    await sleep(poll * (0.5 + Math.random()))
  }
}

/**
 * Downloads and unpacks into a staging folder beside the engine's, writes the marker last and renames the folder
 * into place, so an interrupted install leaves only a staging folder that nothing loads and the next install clears.
 */
const place = async (pin: EnginePin, folder: string, target: Target, options: EnsureOptions): Promise<void> => {
  const packages = packagesFor(pin, target)
  if (packages.length === 0)
    throw new CliError("validation_error", `${pin.name} has no package for ${target.platform}-${target.arch}`)
  const parent = dirname(folder)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  clearLeftovers(parent, folder)
  const staging = join(parent, `.staging-${randomUUID()}`)
  mkdirSync(join(staging, ".tarballs"), { recursive: true, mode: 0o700 })
  try {
    const bytes = packages.reduce((sum, pkg) => sum + pkg.bytes, 0)
    options.progress?.(`installing ${pin.name} ${pin.version} (${megabytes(bytes)}) into ${folder}`)
    const tarballs = packages.map((_, index) => join(staging, ".tarballs", `${index}.tgz`))
    await installFiles(
      packages.map((pkg, index) => [
        { name: `${pkg.name}@${pkg.version}`, url: pkg.url, integrity: pkg.integrity, bytes: pkg.bytes },
        tarballs[index] as string,
      ]),
      {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.progress ? { progress: options.progress } : {}),
      },
    )
    packages.forEach((pkg, index) => {
      unpack(
        gunzipSync(readFileSync(tarballs[index] as string)),
        join(staging, "node_modules", ...pkg.name.split("/")),
        pkg,
      )
    })
    rmSync(join(staging, ".tarballs"), { recursive: true, force: true })
    writeFileSync(join(staging, MARKER), markerOf(pin, target), { mode: 0o600 })
    await moveIntoPlace(staging, folder, options)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** Defender and the indexer hold a file just written for a moment on Windows, and a rename then fails. */
const moveIntoPlace = async (staging: string, folder: string, options: EnsureOptions) => {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (let attempt = 1; ; attempt += 1)
    try {
      renameSync(staging, folder)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ""
      if (attempt < 10 && ["EPERM", "EBUSY", "EACCES"].includes(code) && process.platform === "win32") {
        await sleep(attempt * 50)
        continue
      }
      throw new CliError("conflict", `could not move the installed engine into ${folder} (${code}) — try again`)
    }
}

/**
 * Only called under the lock: a staging folder then belongs to no running install, and a folder at the engine's own
 * place without its marker was never loaded.
 */
const clearLeftovers = (parent: string, folder: string) => {
  for (const entry of readdirSync(parent))
    if (entry.startsWith(".staging-"))
      try {
        rmSync(join(parent, entry), { recursive: true, force: true })
      } catch {}
  rmSync(folder, { recursive: true, force: true })
}

/**
 * Every file of the tarball under `destination`, its first folder (`package/`) dropped. A link, an absolute path or a
 * `..` would reach outside the engine's folder, so the whole package is refused for it.
 */
const unpack = (tar: Uint8Array, destination: string, pkg: EnginePackage) => {
  const refuse = (path: string) =>
    new CliError(
      "invalid_response",
      `${pkg.name}@${pkg.version} holds ${path}, outside its folder — nothing was installed`,
    )
  for (const entry of tarEntries(tar)) {
    const parts = entry.path.split("/").slice(1)
    const path = parts.join("/")
    if (parts.length === 0 || path === "") continue
    if (
      entry.path.startsWith("/") ||
      /^[a-z]:/i.test(entry.path) ||
      parts.some((part) => part === ".." || part.includes("\\"))
    )
      throw refuse(entry.path)
    const target = join(destination, ...parts)
    if (entry.type === "5") {
      mkdirSync(target, { recursive: true, mode: 0o755 })
    } else if (entry.type === "0" || entry.type === "") {
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 })
      writeFileSync(target, entry.data, { mode: entry.mode & 0o111 ? 0o755 : 0o644 })
    } else throw refuse(`${entry.path} (a link)`)
  }
}

const UNWRITABLE = new Set(["EACCES", "EPERM", "EROFS"])

const reasonOf = (error: unknown, directory: string): string => {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code && UNWRITABLE.has(code))
    return `cannot write to ${directory} (${code}): make it writable, or point WIRECAT_STATE_DIR at a folder you can write`
  if (code === "ENOSPC") return `no space left in ${directory}`
  return error instanceof Error ? error.message : String(error)
}

export interface InstalledEngine {
  name: string
  version: string
  path: string
  /** Whether this cli-core would load it: its version and packages are the ones it pins for this system. */
  current: boolean
}

/** What `doctor` shows: every engine folder with a marker, whichever cli-core installed it. */
export const installedEngines = (
  pins: Readonly<Record<string, EnginePin>>,
  env: NodeJS.ProcessEnv = process.env,
  target: Target = currentTarget(),
): InstalledEngine[] => {
  const root = enginesDirectory(env)
  const names = (folder: string, prefix = ""): string[] =>
    entries(folder).flatMap((entry) =>
      entry.startsWith("@") && prefix === "" ? names(join(folder, entry), `${entry}/`) : [`${prefix}${entry}`],
    )
  const placed = (folder: string) =>
    entries(folder).filter((entry) => !entry.startsWith(".") && !entry.endsWith(".lock"))
  return names(root).flatMap((name) =>
    placed(join(root, ...name.split("/"))).flatMap((version) =>
      placed(join(root, ...name.split("/"), version)).flatMap((key) => {
        const path = join(root, ...name.split("/"), version, key)
        if (!readMarker(path)) return []
        const pin = pins[name]
        return [
          {
            name,
            version,
            path,
            current:
              pin !== undefined && path === engineFolder(pin, env, target) && isEngineInstalled(pin, env, target),
          },
        ]
      }),
    ),
  )
}

const entries = (folder: string): string[] => {
  try {
    return readdirSync(folder).sort()
  } catch {
    return []
  }
}
