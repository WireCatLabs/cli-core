# @wirecat/cli-core-onnx

[ONNX Runtime](https://onnxruntime.ai/) 1.30.0 for Node and Bun, WebAssembly only: the Node build of
`onnxruntime-web` and the one WebAssembly module it loads, about 15 MB instead of the 145 MB package
that also carries every browser build. `@wirecat/cli-core` runs its local embedding models with it.

```js
import { env, InferenceSession, Tensor } from "@wirecat/cli-core-onnx"
```

The API is ONNX Runtime's own ([docs](https://onnxruntime.ai/docs/api/js/)). Bun picks one thread
unless `env.wasm.numThreads` is set.

`build.sh` copies `ort.node.min.mjs`, `ort-wasm-simd-threaded.mjs` and `ort-wasm-simd-threaded.wasm` out
of `onnxruntime-web-1.30.0.tgz`, after checking the tarball against the integrity npm records for it.
`probe.mjs` runs a one-node model (`test/multiply.onnx`) through the package. ONNX Runtime is MIT
licensed by Microsoft (`LICENSE-onnxruntime`).
