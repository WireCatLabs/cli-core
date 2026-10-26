import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ONNX_RUNTIME_VERSION as PACKAGE_VERSION } from "@wirecat/cli-core-onnx"
import { gzipSync } from "fflate"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  installNativeRuntime,
  type NativeRuntime,
  nativeRuntimeFor,
  ONNX_RUNTIME_VERSION,
  onnxRuntime,
  runtimeFolder,
} from "./onnx-runtime.js"

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const library = new TextEncoder().encode("the library's bytes")

/** A ustar archive, as Microsoft's macOS one: `./` paths, a PAX header, a symlink to the library. */
const tarOf = (entries: { name: string; data?: Uint8Array; type?: string }[]): Uint8Array => {
  const blocks: Uint8Array[] = []
  for (const { name, data = new Uint8Array(), type = "0" } of entries) {
    const header = new Uint8Array(512)
    const put = (text: string, at: number) => header.set(new TextEncoder().encode(text), at)
    put(name.slice(0, 100), 0)
    put(`${data.length.toString(8).padStart(11, "0")}\0`, 124)
    put(type, 156)
    put("ustar\0", 257)
    blocks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512))
  }
  const tar = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0) + 1024)
  let at = 0
  for (const block of blocks) {
    tar.set(block, at)
    at += block.length
  }
  return tar
}

const pax = (path: string) => {
  const record = (length: number) => `${length} path=${path}\n`
  let length = record(0).length
  while (record(length).length !== length) length = record(length).length
  return new TextEncoder().encode(record(length))
}

const longPath = `onnxruntime-osx-arm64-${ONNX_RUNTIME_VERSION}/lib/${"deep/".repeat(20)}libonnxruntime.1.30.0.dylib`

const served = (archive: Uint8Array, name: string, member: string): NativeRuntime => ({
  target: "test-x64",
  archive: { name, url: `https://example.test/${name}`, sha256: sha256(archive), bytes: archive.length },
  member,
  library: { name: "libonnxruntime.test", sha256: sha256(library), bytes: library.length },
})

const fetchOf = (archive: Uint8Array) => vi.fn(async () => new Response(Buffer.from(archive)))

const binding = () => {
  const path = join(mkdtempSync(join(tmpdir(), "binding-")), "onnxruntime_binding.node")
  writeFileSync(path, "not a binding")
  return path
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("the native ONNX Runtime", () => {
  it("is the version of the binding @wirecat/cli-core-onnx carries", () => {
    expect(ONNX_RUNTIME_VERSION).toBe(PACKAGE_VERSION)
  })

  it("is installed out of a tar archive, beside a copy of the binding, and only once", async () => {
    const archive = gzipSync(
      tarOf([
        { name: "./onnxruntime-osx-arm64-1.30.0/lib/", type: "5" },
        { name: "PaxHeader", data: pax(`./${longPath}`), type: "x" },
        { name: "truncated-name", data: library },
        { name: "./onnxruntime-osx-arm64-1.30.0/lib/libonnxruntime.1.dylib", type: "2" },
      ]),
    )
    const runtime = served(archive, "onnxruntime-osx-arm64-1.30.0.tgz", longPath)
    const env = { WIRECAT_STATE_DIR: mkdtempSync(join(tmpdir(), "runtime-")) }
    const fetch = fetchOf(archive)

    const folder = await installNativeRuntime({ env, fetch, runtime, binding: binding() })
    await installNativeRuntime({ env, fetch, runtime, binding: binding() })

    expect(folder).toBe(runtimeFolder(runtime, env))
    expect(readFileSync(join(folder as string, "libonnxruntime.test"))).toEqual(Buffer.from(library))
    expect(readFileSync(join(folder as string, "onnxruntime_binding.node"), "utf8")).toBe("not a binding")
    expect(existsSync(join(folder as string, "onnxruntime-osx-arm64-1.30.0.tgz"))).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("installs nothing when the archive holds another library", async () => {
    const member = "onnxruntime-linux-x64-1.30.0/lib/libonnxruntime.so.1.30.0"
    const archive = gzipSync(tarOf([{ name: member, data: new TextEncoder().encode("another library") }]))
    const runtime = served(archive, "onnxruntime-linux-x64-1.30.0.tgz", member)
    const env = { WIRECAT_STATE_DIR: mkdtempSync(join(tmpdir(), "runtime-")) }

    await expect(installNativeRuntime({ env, fetch: fetchOf(archive), runtime, binding: binding() })).rejects.toThrow(
      "does not hold the libonnxruntime.test this version expects",
    )
    expect(existsSync(runtimeFolder(runtime, env))).toBe(false)
  })

  it("is not offered on musl, nor on a system the release workflow does not run", () => {
    expect(nativeRuntimeFor({ platform: "linux", arch: "x64", musl: false })?.library.name).toBe("libonnxruntime.so.1")
    expect(nativeRuntimeFor({ platform: "linux", arch: "x64", musl: true })).toBeUndefined()
    expect(nativeRuntimeFor({ platform: "darwin", arch: "x64" })).toBeUndefined()
    expect(nativeRuntimeFor({ platform: "win32", arch: "x64" })).toBeUndefined()
  })

  it("leaves the models on WebAssembly when the installed binding does not load", async () => {
    const runtime = nativeRuntimeFor()
    if (!runtime) return
    const env = { WIRECAT_STATE_DIR: mkdtempSync(join(tmpdir(), "runtime-")) }
    const folder = runtimeFolder(runtime, env)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, runtime.library.name), Buffer.alloc(runtime.library.bytes))
    writeFileSync(join(folder, "onnxruntime_binding.node"), "not a binding")

    const { native, ort } = await onnxRuntime(env)

    expect(native).toBe(false)
    expect(ort.env.wasm).toBeDefined()
  })
})
