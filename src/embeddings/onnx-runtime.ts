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

/** The library in the archive it comes in, and the name the binding looks for beside itself. */
export interface NativeRuntime {
  readonly target: string
  readonly archive: ModelFile
  readonly member: string
  readonly library: { name: string; sha256: string; bytes: number }
}

const REGISTRY = "https://registry.npmjs.org"

/**
 * WireCat's own package of this system's library, on npm: Microsoft's GitHub releases went away on 17.11.2026, so no
 * download depends on Microsoft's hosting. `bin/publish-onnxruntime` builds them from Microsoft's NuGet package, and
 * on Windows from onnxruntime-node's npm tarball: its binding imports the DirectML build of onnxruntime.dll by
 * ordinal, which Microsoft's CPU build lacks; DirectML.dll is loaded only when used, so the DLL alone runs on CPU.
 */
const wirecat = (
  target: string,
  sha256: string,
  bytes: number,
  library: NativeRuntime["library"],
): Omit<NativeRuntime, "target"> => ({
  archive: {
    name: `onnxruntime-${target}-${ONNX_RUNTIME_VERSION}.tgz`,
    url: `${REGISTRY}/@wirecat/onnxruntime-${target}/-/onnxruntime-${target}-${ONNX_RUNTIME_VERSION}.tgz`,
    sha256,
    bytes,
  },
  member: `package/${library.name}`,
  library,
})

/** The systems the native-runtime workflow runs natively; elsewhere, and on musl, the models run through WebAssembly. */
const NATIVE: Record<string, Omit<NativeRuntime, "target">> = {
  "linux-x64": wirecat("linux-x64", "9c12e88ae495ae04e28802e52c2524a7a9c31aa715a67eeb636c85efcb08e5d9", 11_305_384, {
    name: "libonnxruntime.so.1",
    sha256: "245a6f8c38127551057a1cd1ffd59f0a186a227ade4f3492dea2494eb565542e",
    bytes: 28_985_152,
  }),
  "linux-arm64": wirecat(
    "linux-arm64",
    "4ec23a63f0e7f49edb63590f4bc8b0e8526bff5b3a2b19d768112f37dc50d09c",
    10_386_392,
    {
      name: "libonnxruntime.so.1",
      sha256: "64e903a43a041240fd6bcffe0ac6d4fea47ef87bf24b9d097801bd00a9612a4b",
      bytes: 25_135_496,
    },
  ),
  "darwin-arm64": wirecat(
    "darwin-arm64",
    "0e543a584a048b301ff96b81af4b001288e048577ce0f0b4a5a9c2df97979615",
    12_921_423,
    {
      name: "libonnxruntime.1.dylib",
      sha256: "bffaa6ef856dba2c26f09c7c0e7018fd1562625f3485292c7ad28b83748c6879",
      bytes: 43_879_424,
    },
  ),
  "win32-x64": wirecat("win32-x64", "55924c8e4c3f975d131e943712c5fac6e5423fb2b0c356c96230f2ad18dc2792", 10_652_326, {
    name: "onnxruntime.dll",
    sha256: "508c362f5673483dd3a086379c392795b2e42d10d5e6f3f90ebd7ac21c97af67",
    bytes: 28_754_232,
  }),
  "win32-arm64": wirecat(
    "win32-arm64",
    "77e43743e580d6641e49b7cdeed57fd11f21a8cf27a186dd33a3db817b3ff7f2",
    10_778_591,
    {
      name: "onnxruntime.dll",
      sha256: "6c3a2abf5c6aca11c48a0d338a91af309f2266f25ce2e4084e6a87bbcb0fbfd0",
      bytes: 29_815_136,
    },
  ),
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
 * The library this system's binding links to, out of WireCat's npm package of it, checked against its own sha256
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

  progress(`ONNX Runtime ${ONNX_RUNTIME_VERSION} for ${runtime.target}: ${megabytes(runtime.archive.bytes)} from npm`)
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

/**
 * A session on the native runtime when it is installed and opens this model, else on WebAssembly, with the `ort`
 * whose tensors that session takes.
 */
export const openSession = async (
  bytes: Uint8Array,
  threads: number,
  options: { externalData?: { path: string; data: Uint8Array }[] } = {},
) => {
  const runtime = await onnxRuntime()
  if (runtime.native) {
    try {
      const session = await runtime.ort.InferenceSession.create(bytes, {
        ...options,
        intraOpNumThreads: threads,
        interOpNumThreads: 1,
      })
      return { ort: runtime.ort, session }
    } catch {
      // A model the native runtime will not open still runs through WebAssembly.
    }
  }
  const ort = await import("@wirecat/cli-core-onnx")
  ort.env.wasm.numThreads = threads
  return { ort, session: await ort.InferenceSession.create(bytes, options) }
}
