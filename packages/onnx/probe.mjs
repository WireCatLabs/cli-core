// Runs a one-node model through the package as published: `node probe.mjs` and `bun probe.mjs`.
import { readFileSync } from "node:fs"
import { env, InferenceSession, Tensor } from "@wirecat/cli-core-onnx"

env.wasm.numThreads = Number(process.env.THREADS ?? 2)
const session = await InferenceSession.create(readFileSync(new URL("./test/multiply.onnx", import.meta.url)))
const { y } = await session.run({ x: new Tensor("float32", Float32Array.from([1, 1, 1]), [1, 3]) })
const got = Array.from(y.data)
if (got.join(",") !== "1,2,3") throw new Error(`expected 1,2,3, got ${got}`)
await session.release()
console.log(
  `onnx ok: ${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`}, ${env.wasm.numThreads} threads`,
)
