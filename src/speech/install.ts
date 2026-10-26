import { createHash, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream, mkdirSync, statSync } from "node:fs"
import { rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { CliError } from "@wirecat/cli-base"
import { wirecatDirectory } from "../store/path.js"
import { type ModelFile, type SpeechModel, VAD } from "./models.js"

/** Shared by every CLI of the family, whatever it talks to: a model is hundreds of MB and is downloaded once. */
export const sharedModelsDirectory = (
  kind: "audio" | "text" | "image" | "runtime",
  env: NodeJS.ProcessEnv = process.env,
): string => join(wirecatDirectory(env), "models", kind)

export const modelsDirectory = (env: NodeJS.ProcessEnv = process.env): string => sharedModelsDirectory("audio", env)

/** No byte for this long and the download is given up — however large the file, it is moving or not. */
const STALL_MS = 60_000

interface Watchdog {
  readonly signal: AbortSignal
  poke(): void
  stop(): void
}

const watchdog = (ms: number): Watchdog => {
  const controller = new AbortController()
  let timer = setTimeout(() => controller.abort(), ms)
  return {
    signal: controller.signal,
    poke: () => {
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(), ms)
    },
    stop: () => clearTimeout(timer),
  }
}

export const modelPath = (directory: string, model: SpeechModel) => (name: string) => join(directory, model.id, name)

export const vadPath = (directory: string): string => join(directory, VAD.name)

const placed = (model: SpeechModel, directory: string): [ModelFile, string][] => [
  ...model.files.map((file): [ModelFile, string] => [file, modelPath(directory, model)(file.name)]),
  [VAD, vadPath(directory)],
]

/**
 * Size, not hash: hashing 650 MB on every call would cost more than the transcription. The hash is
 * checked once, as the file arrives, and a file only reaches its name after passing it.
 */
export const isInstalled = (model: SpeechModel, directory: string): boolean => filesPresent(placed(model, directory))

export const filesPresent = (files: [ModelFile, string][]): boolean =>
  files.every(([file, path]) => sizeOf(path) === file.bytes)

const sizeOf = (path: string): number | undefined => {
  try {
    return statSync(path).size
  } catch {
    return undefined
  }
}

export const installedBytes = (model: SpeechModel): number => model.files.reduce((sum, file) => sum + file.bytes, 0)

export type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

export const install = async (
  model: SpeechModel,
  directory: string,
  {
    fetch: get = fetch,
    progress,
    verifyExisting,
  }: { fetch?: Fetch; progress?: (line: string) => void; verifyExisting?: boolean } = {},
): Promise<void> => {
  mkdirSync(join(directory, model.id), { recursive: true, mode: 0o700 })
  await installFiles(placed(model, directory), { fetch: get, progress, verifyExisting })
}

/** Each file not already in place, downloaded and checked against its sha256 before it takes its name. */
export const installFiles = async (
  files: [ModelFile, string][],
  {
    fetch: get = fetch,
    progress,
    verifyExisting,
  }: { fetch?: Fetch; progress?: (line: string) => void; verifyExisting?: boolean } = {},
): Promise<void> => {
  if (verifyExisting)
    for (const [file, path] of files) {
      if (sizeOf(path) !== undefined) {
        const hash = createHash("sha256")
        for await (const chunk of createReadStream(path)) hash.update(chunk)
        if (hash.digest("hex") !== file.sha256) {
          progress?.(`${path}: not the file this version expects, downloading it again`)
          await rm(path, { force: true })
        }
      }
    }
  for (const [file, path] of files) {
    if (sizeOf(path) === file.bytes) continue
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    progress?.(`downloading ${file.name} (${megabytes(file.bytes)})`)
    await fetchVerified(file, path, get)
  }
}

const fetchVerified = async (file: ModelFile, path: string, get: Fetch): Promise<void> => {
  const stalled = watchdog(STALL_MS)
  try {
    await fetchInto(file, path, get, stalled)
  } catch (error) {
    if (stalled.signal.aborted) {
      throw new CliError("timeout", `${file.name} stopped downloading for ${STALL_MS / 1000} s — nothing was installed`)
    }
    throw error
  } finally {
    stalled.stop()
  }
}

const fetchInto = async (file: ModelFile, path: string, get: Fetch, stalled: Watchdog): Promise<void> => {
  const response = await get(file.url, { signal: stalled.signal })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new CliError("network_error", `${file.name} could not be downloaded: HTTP ${response.status}`)
  }

  const partial = `${path}.${randomUUID()}.part`
  const hash = createHash("sha256")
  let bytes = 0
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      stalled.poke()
      bytes += chunk.length
      if (bytes > file.bytes) {
        done(
          new CliError("invalid_response", `${file.name} is larger than this version expects — nothing was installed`),
        )
        return
      }
      hash.update(chunk)
      done(null, chunk)
    },
  })

  try {
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      hashing,
      createWriteStream(partial, { flags: "wx", mode: 0o600 }),
    )
    const actual = hash.digest("hex")
    if (actual !== file.sha256) {
      throw new CliError(
        "invalid_response",
        `${file.name} is not the file this version expects (sha256 ${actual}) — nothing was installed`,
      )
    }
    await rename(partial, path)
  } finally {
    await rm(partial, { force: true })
  }
}

export const megabytes = (bytes: number): string =>
  bytes < 1_000_000 ? "under 1 MB" : `${Math.round(bytes / 1_000_000)} MB`
