import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

export * from "./dist/ort.node.min.mjs"

export const ONNX_RUNTIME_VERSION = "1.30.0"

const require = createRequire(import.meta.url)

export const nativeBindingFor = ({ platform = process.platform, arch = process.arch } = {}) => {
  const path = fileURLToPath(new URL(`./native/${platform}-${arch}/onnxruntime_binding.node`, import.meta.url))
  return existsSync(path) ? path : undefined
}

export const openNative = (binding) => {
  require("./native/location.js").use(binding)
  return require("./native/index.js")
}
