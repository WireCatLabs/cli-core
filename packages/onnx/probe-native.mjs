// Runs the one-node model through the native binding of this system, beside the ONNX Runtime library of Microsoft's
// release that @wirecat/cli-core downloads: `node probe-native.mjs` and `bun probe-native.mjs`.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nativeBindingFor, ONNX_RUNTIME_VERSION, openNative } from "@wirecat/cli-core-onnx"

const release = `https://github.com/microsoft/onnxruntime/releases/download/v${ONNX_RUNTIME_VERSION}`
const archives = {
  "linux-x64": [
    "onnxruntime-linux-x64-1.30.0.tgz",
    "a5ed5a3cac51fbb2e90da632ae43d19212faaa20e76484e62bcb7c23ddb3b3fd",
    "onnxruntime-linux-x64-1.30.0/lib/libonnxruntime.so.1.30.0",
    "libonnxruntime.so.1",
  ],
  "linux-arm64": [
    "onnxruntime-linux-aarch64-1.30.0.tgz",
    "e16a27a8ed330bbc698df7330b0cf56e722f354e3bcc92118682c74ef3c3e3da",
    "onnxruntime-linux-aarch64-1.30.0/lib/libonnxruntime.so.1.30.0",
    "libonnxruntime.so.1",
  ],
  "darwin-arm64": [
    "onnxruntime-osx-arm64-1.30.0.tgz",
    "6ebb5062a934537c352937821f9fe9718e7de1a2db1122a93dd363ffd53a7012",
    "./onnxruntime-osx-arm64-1.30.0/lib/libonnxruntime.1.30.0.dylib",
    "libonnxruntime.1.dylib",
  ],
}
const target = `${process.platform}-${process.arch}`
const [name, sha256, member, library] = archives[target] ?? []
if (!name) throw new Error(`no ONNX Runtime archive for ${target}`)
const binding = nativeBindingFor()
if (!binding) throw new Error(`the package carries no binding for ${target}`)

const work = mkdtempSync(join(tmpdir(), "onnx-native-"))
const archive = Buffer.from(await (await fetch(`${release}/${name}`)).arrayBuffer())
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
