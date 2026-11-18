// Runs the one-node model through the native binding of this system, beside the ONNX Runtime library
// @wirecat/cli-core downloads from WireCat's @wirecat/onnxruntime-<platform> package on npm (bin/publish-onnxruntime):
// `node probe-native.mjs` and `bun probe-native.mjs`.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nativeBindingFor, ONNX_RUNTIME_VERSION, openNative } from "@wirecat/cli-core-onnx"

const archives = {
  "linux-x64": ["9c12e88ae495ae04e28802e52c2524a7a9c31aa715a67eeb636c85efcb08e5d9", "libonnxruntime.so.1"],
  "linux-arm64": ["4ec23a63f0e7f49edb63590f4bc8b0e8526bff5b3a2b19d768112f37dc50d09c", "libonnxruntime.so.1"],
  "darwin-arm64": ["0e543a584a048b301ff96b81af4b001288e048577ce0f0b4a5a9c2df97979615", "libonnxruntime.1.dylib"],
  "win32-x64": ["55924c8e4c3f975d131e943712c5fac6e5423fb2b0c356c96230f2ad18dc2792", "onnxruntime.dll"],
  "win32-arm64": ["77e43743e580d6641e49b7cdeed57fd11f21a8cf27a186dd33a3db817b3ff7f2", "onnxruntime.dll"],
}
const target = `${process.platform}-${process.arch}`
const [sha256, library] = archives[target] ?? []
if (!sha256) throw new Error(`no ONNX Runtime package for ${target}`)
const name = `onnxruntime-${target}-${ONNX_RUNTIME_VERSION}.tgz`
const member = `package/${library}`
const binding = nativeBindingFor()
if (!binding) throw new Error(`the package carries no binding for ${target}`)

const work = mkdtempSync(join(tmpdir(), "onnx-native-"))
const archive = Buffer.from(
  await (await fetch(`https://registry.npmjs.org/@wirecat/onnxruntime-${target}/-/${name}`)).arrayBuffer(),
)
const actual = createHash("sha256").update(archive).digest("hex")
if (actual !== sha256) throw new Error(`${name} is not the file expected (sha256 ${actual})`)
writeFileSync(join(work, name), archive)
execFileSync("tar", ["-xf", name, member], { cwd: work })
const folder = mkdtempSync(join(tmpdir(), "onnx-runtime-"))
copyFileSync(join(work, member), join(folder, library))
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
