import { createHash } from "node:crypto"
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { gunzipSync } from "fflate"
import { type Fetch, installFiles, megabytes, sharedModelsDirectory } from "../speech/install.js"
import type { ModelFile } from "../speech/models.js"

export const ONNX_RUNTIME_VERSION = "1.30.0"

/** The library of Microsoft's release, in its archive, and the name the binding looks for beside itself. */
export interface NativeRuntime {
  readonly target: string
  readonly archive: ModelFile
  readonly member: string
  readonly library: { name: string; sha256: string; bytes: number }
}

const release = (name: string, sha256: string, bytes: number): ModelFile => ({
  name,
  url: `https://github.com/microsoft/onnxruntime/releases/download/v${ONNX_RUNTIME_VERSION}/${name}`,
  sha256,
  bytes,
})

/**
 * The systems the ONNX workflow runs natively; everywhere else, and on musl, the models run through WebAssembly.
 * Windows too: its binding needs the DirectML build of onnxruntime.dll, which Microsoft's release does not carry.
 */
const NATIVE: Record<string, Omit<NativeRuntime, "target">> = {
  "linux-x64": {
    archive: release(
      "onnxruntime-linux-x64-1.30.0.tgz",
      "a5ed5a3cac51fbb2e90da632ae43d19212faaa20e76484e62bcb7c23ddb3b3fd",
      11_306_877,
    ),
    member: "onnxruntime-linux-x64-1.30.0/lib/libonnxruntime.so.1.30.0",
    library: {
      name: "libonnxruntime.so.1",
      sha256: "245a6f8c38127551057a1cd1ffd59f0a186a227ade4f3492dea2494eb565542e",
      bytes: 28_985_152,
    },
  },
  "linux-arm64": {
    archive: release(
      "onnxruntime-linux-aarch64-1.30.0.tgz",
      "e16a27a8ed330bbc698df7330b0cf56e722f354e3bcc92118682c74ef3c3e3da",
      10_269_495,
    ),
    member: "onnxruntime-linux-aarch64-1.30.0/lib/libonnxruntime.so.1.30.0",
    library: {
      name: "libonnxruntime.so.1",
      sha256: "64e903a43a041240fd6bcffe0ac6d4fea47ef87bf24b9d097801bd00a9612a4b",
      bytes: 25_135_496,
    },
  },
  "darwin-arm64": {
    archive: release(
      "onnxruntime-osx-arm64-1.30.0.tgz",
      "6ebb5062a934537c352937821f9fe9718e7de1a2db1122a93dd363ffd53a7012",
      42_373_116,
    ),
    member: "onnxruntime-osx-arm64-1.30.0/lib/libonnxruntime.1.30.0.dylib",
    library: {
      name: "libonnxruntime.1.dylib",
      sha256: "bcc9110f9d638a119de2db7afb3ba9a1da8085f0cb3401e1c48ae1caf450b6fa",
      bytes: 43_879_424,
    },
  },
}

const onMusl = (): boolean => {
  try {
    return readFileSync("/proc/self/maps", "utf8").includes("ld-musl")
  } catch {
    return false
  }
}

export const nativeRuntimeFor = ({
  platform = process.platform,
  arch = process.arch,
  musl = platform === "linux" && onMusl(),
}: {
  platform?: string
  arch?: string
  musl?: boolean
} = {}): NativeRuntime | undefined => {
  const target = `${platform}-${arch}`
  const runtime = NATIVE[target]
  return runtime && !musl ? { target, ...runtime } : undefined
}

export const runtimeFolder = (runtime: NativeRuntime, env: NodeJS.ProcessEnv = process.env): string =>
  join(sharedModelsDirectory("runtime", env), `onnxruntime-${ONNX_RUNTIME_VERSION}-${runtime.target}`)

const BINDING = "onnxruntime_binding.node"

const sizeOf = (path: string): number | undefined => {
  try {
    return statSync(path).size
  } catch {
    return undefined
  }
}

const isInstalled = (runtime: NativeRuntime, folder: string): boolean =>
  sizeOf(join(folder, runtime.library.name)) === runtime.library.bytes && sizeOf(join(folder, BINDING)) !== undefined

/**
 * The library this system's binding links to, out of Microsoft's release archive, checked against its own sha256
 * and placed beside a copy of the binding, which loads it from its own folder. Only from `models download`: a search
 * never downloads. `undefined` when this system runs models through WebAssembly only.
 */
export const installNativeRuntime = async ({
  env = process.env,
  progress = () => {},
  fetch,
  runtime = nativeRuntimeFor(),
  binding,
}: {
  env?: NodeJS.ProcessEnv
  progress?: (line: string) => void
  fetch?: Fetch
  runtime?: NativeRuntime
  binding?: string
} = {}): Promise<string | undefined> => {
  if (!runtime) return undefined
  const source = binding ?? (await import("@wirecat/cli-core-onnx")).nativeBindingFor()
  if (!source) return undefined
  const folder = runtimeFolder(runtime, env)
  if (isInstalled(runtime, folder)) return folder

  progress(
    `ONNX Runtime ${ONNX_RUNTIME_VERSION} for ${runtime.target}: ${megabytes(runtime.archive.bytes)} from Microsoft`,
  )
  const parent = sharedModelsDirectory("runtime", env)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const staging = mkdtempSync(join(parent, ".onnxruntime-"))
  try {
    const archive = join(staging, runtime.archive.name)
    await installFiles([[runtime.archive, archive]], { ...(fetch ? { fetch } : {}), progress })
    const library = tarMember(gunzipSync(readFileSync(archive)), runtime.member)
    rmSync(archive)
    const sha256 = library && createHash("sha256").update(library).digest("hex")
    if (!library || library.length !== runtime.library.bytes || sha256 !== runtime.library.sha256)
      throw new CliError(
        "invalid_response",
        `${runtime.archive.name} does not hold the ${runtime.library.name} this version expects — nothing was installed`,
      )
    writeFileSync(join(staging, runtime.library.name), library, { mode: 0o755 })
    copyFileSync(source, join(staging, BINDING))
    rmSync(folder, { recursive: true, force: true })
    renameSync(staging, folder)
    return folder
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** One regular file of a ustar archive, by its path: PAX and GNU long names, and a leading `./`, are understood. */
const tarMember = (tar: Uint8Array, member: string): Uint8Array | undefined => {
  const text = (from: number, length: number) =>
    new TextDecoder().decode(tar.subarray(from, from + length)).replace(/\0.*$/s, "")
  const plain = (path: string) => path.replace(/^\.\//, "")
  let longName: string | undefined
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const name = text(offset, 100)
    if (!name) return undefined
    const size = Number.parseInt(text(offset + 124, 12).trim() || "0", 8)
    const type = text(offset + 156, 1)
    const prefix = text(offset + 345, 155)
    const data = tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === "x") {
      longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(data))?.[1] ?? longName
      continue
    }
    if (type === "L") {
      longName = new TextDecoder().decode(data).replace(/\0.*$/s, "")
      continue
    }
    const path = plain(longName ?? (prefix ? `${prefix}/${name}` : name))
    longName = undefined
    if (path === plain(member) && (type === "0" || type === "")) return data
  }
  return undefined
}

export type Ort = typeof import("@wirecat/cli-core-onnx")

export interface OnnxRuntime {
  readonly ort: Ort
  readonly native: boolean
}

const opened = new Map<string, Promise<OnnxRuntime>>()

/**
 * The native runtime when `models download` placed it for this system and it loads, else WebAssembly. One per
 * process: a binding, once loaded, stays.
 */
export const onnxRuntime = (env: NodeJS.ProcessEnv = process.env): Promise<OnnxRuntime> => {
  const runtime = nativeRuntimeFor()
  const folder = runtime ? runtimeFolder(runtime, env) : ""
  let found = opened.get(folder)
  if (!found) {
    found = (async () => {
      const wasm = await import("@wirecat/cli-core-onnx")
      if (runtime && isInstalled(runtime, folder)) {
        try {
          return { ort: wasm.openNative(join(folder, BINDING)) as Ort, native: true }
        } catch {
          // A library that does not load on this system: WebAssembly runs the same models, slower.
        }
      }
      return { ort: wasm, native: false }
    })()
    opened.set(folder, found)
  }
  return found
}
