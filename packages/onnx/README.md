# @wirecat/cli-core-onnx

[ONNX Runtime](https://onnxruntime.ai/) 1.30.0 for Node and Bun, as `@wirecat/cli-core` runs its local models:

- **WebAssembly**, on every system: the Node build of `onnxruntime-web` and the one WebAssembly module it loads,
  about 15 MB instead of the 145 MB package that also carries every browser build.
- **Native**, 2–3× faster, on Linux x64 and arm64 (glibc), macOS arm64 and Windows x64 and arm64:
  `onnxruntime-node`'s JavaScript and the 0.3–0.4 MB binding of each of those systems, without its libraries.
  `@wirecat/cli-core` downloads the library beside a copy of the binding, which loads it from its own folder: from Microsoft's release of
  the same version, and on Windows from `onnxruntime-node`'s own npm tarball, because the Windows binding needs the
  DirectML build of `onnxruntime.dll` (export ordinal 4) that Microsoft's CPU release does not carry.

```js
import { env, InferenceSession, Tensor } from "@wirecat/cli-core-onnx" // WebAssembly
import { nativeBindingFor, openNative } from "@wirecat/cli-core-onnx"
const ort = openNative("/folder/with/onnxruntime_binding.node") // the library beside it; throws if it does not load
```

The API is ONNX Runtime's own ([docs](https://onnxruntime.ai/docs/api/js/)). Bun picks one WebAssembly thread
unless `env.wasm.numThreads` is set. A process keeps the first native binding it opens.

`build.sh` copies `ort.node.min.mjs`, `ort-wasm-simd-threaded.mjs` and `ort-wasm-simd-threaded.wasm` out of
`onnxruntime-web-1.30.0.tgz`, and `dist/*.js` with `bin/napi-v6/<system>/onnxruntime_binding.node` out of
`onnxruntime-node-1.30.0.tgz`, after checking each tarball against the integrity npm records for it. It changes one
line of `binding.js`, so the binding is loaded from the path `openNative` was given, and stops if that line changed.
`probe.mjs` runs a one-node model (`test/multiply.onnx`) through WebAssembly; `probe-native.mjs` downloads the
system's library the same way, checks its sha256 and runs the same model natively. ONNX Runtime is MIT
licensed by Microsoft (`LICENSE-onnxruntime`).
