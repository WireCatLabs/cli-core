// Runs the one-node model through the native binding of this system, beside the ONNX Runtime library
// @wirecat/cli-core downloads — from Microsoft's NuGet package, or on Windows from onnxruntime-node's npm tarball,
// whose DirectML build of onnxruntime.dll the binding needs: `node probe-native.mjs` and `bun probe-native.mjs`.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inflateRawSync } from "node:zlib"
import { nativeBindingFor, ONNX_RUNTIME_VERSION, openNative } from "@wirecat/cli-core-onnx"

const nuget =
  `https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/${ONNX_RUNTIME_VERSION}` +
  `/microsoft.ml.onnxruntime.${ONNX_RUNTIME_VERSION}.nupkg`
const npm = `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-${ONNX_RUNTIME_VERSION}.tgz`
const npmSha256 = "6e3390d6b783e7be946fad629292799da28d0b42f84856e50d2c1b0383291e75"
// Each library's deflated bytes in the NuGet zip, or its path in the npm tarball, and the name the binding loads.
const sources = {
  "linux-x64": {
    offset: 121_160_280,
    sha256: "6f7d1ee67f9c7d3e5d1b009492aef02d2833ba16a4a896b71438b20abfe4293a",
    bytes: 11_061_061,
    library: "libonnxruntime.so.1",
  },
  "linux-arm64": {
    offset: 111_131_974,
    sha256: "4e8adcdf8582ff74925989b0e009efa808723b23ec297eae4acaababe0ffad8f",
    bytes: 10_026_119,
    library: "libonnxruntime.so.1",
  },
  "darwin-arm64": {
    offset: 132_223_187,
    sha256: "d9f60cc9c7af596e5114a0dbb3afdc62eaa93de0236ce6e6aa4500ace7b39c0a",
    bytes: 12_536_089,
    library: "libonnxruntime.1.dylib",
  },
  "win32-x64": { member: "package/bin/napi-v6/win32/x64/onnxruntime.dll", library: "onnxruntime.dll" },
  "win32-arm64": { member: "package/bin/napi-v6/win32/arm64/onnxruntime.dll", library: "onnxruntime.dll" },
}
const target = `${process.platform}-${process.arch}`
const source = sources[target]
if (!source) throw new Error(`no ONNX Runtime library for ${target}`)
const binding = nativeBindingFor()
if (!binding) throw new Error(`the package carries no binding for ${target}`)

const folder = mkdtempSync(join(tmpdir(), "onnx-runtime-"))
if (source.member) {
  const archive = Buffer.from(await (await fetch(npm)).arrayBuffer())
  const actual = createHash("sha256").update(archive).digest("hex")
  if (actual !== npmSha256) throw new Error(`the npm tarball is not the file expected (sha256 ${actual})`)
  const work = mkdtempSync(join(tmpdir(), "onnx-native-"))
  writeFileSync(join(work, "npm.tgz"), archive)
  execFileSync("tar", ["-xf", "npm.tgz", source.member], { cwd: work })
  copyFileSync(join(work, source.member), join(folder, source.library))
} else {
  const range = `bytes=${source.offset}-${source.offset + source.bytes - 1}`
  const slice = Buffer.from(await (await fetch(nuget, { headers: { Range: range } })).arrayBuffer())
  const actual = createHash("sha256").update(slice).digest("hex")
  if (actual !== source.sha256) throw new Error(`the NuGet slice is not the one expected (sha256 ${actual})`)
  writeFileSync(join(folder, source.library), inflateRawSync(slice))
}
copyFileSync(binding, join(folder, "onnxruntime_binding.node"))

const { InferenceSession, Tensor } = openNative(join(folder, "onnxruntime_binding.node"))
const session = await InferenceSession.create(readFileSync(new URL("./test/multiply.onnx", import.meta.url)), {
  intraOpNumThreads: 2,
})
const { y } = await session.run({ x: new Tensor("float32", Float32Array.from([1, 1, 1]), [1, 3]) })
const got = Array.from(y.data)
if (got.join(",") !== "1,2,3") throw new Error(`expected 1,2,3, got ${got}`)
await session.release()
console.log(
  `onnx native ok: ${target}, ${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`}`,
)
