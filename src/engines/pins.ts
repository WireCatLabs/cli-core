// Written by scripts/engine-pins.ts from pnpm-lock.yaml and the npm registry: run it again, never edit by hand.
import type { EnginePin } from "./install.js"

export const ENGINE_PINS = {
  "sherpa-onnx": {
    name: "sherpa-onnx",
    version: "2.0.0",
    packages: [
      {
        name: "sherpa-onnx",
        version: "2.0.0",
        url: "https://registry.npmjs.org/sherpa-onnx/-/sherpa-onnx-2.0.0.tgz",
        integrity: "sha512-eczLsIIHc7RRJ/e8o7DMvKKhN2+riSKGxznzTCRIUZ+uLgsbSnG9Y3u757rG2Mr4Azu6qR3NAYluwY1/Y7a6FA==",
        bytes: 4296761,
      },
    ],
  },
  "ogg-opus-decoder": {
    name: "ogg-opus-decoder",
    version: "1.7.5",
    packages: [
      {
        name: "ogg-opus-decoder",
        version: "1.7.5",
        url: "https://registry.npmjs.org/ogg-opus-decoder/-/ogg-opus-decoder-1.7.5.tgz",
        integrity: "sha512-08WfRbuBBew1H63PqQ3zj2B/J0Eh9ISfNOTi+Dk6vuXmkBGSx8BiPJGOJ470EYeKezTa7/GhOAwHe3XlXwOZMw==",
        bytes: 6869751,
      },
      {
        name: "@wasm-audio-decoders/common",
        version: "9.0.7",
        url: "https://registry.npmjs.org/@wasm-audio-decoders/common/-/common-9.0.7.tgz",
        integrity: "sha512-WRaUuWSKV7pkttBygml/a6dIEpatq2nnZGFIoPTc5yPLkxL6Wk4YaslPM98OPQvWacvNZ+Py9xROGDtrFBDzag==",
        bytes: 18889,
      },
      {
        name: "@eshaz/web-worker",
        version: "1.2.2",
        url: "https://registry.npmjs.org/@eshaz/web-worker/-/web-worker-1.2.2.tgz",
        integrity: "sha512-WxXiHFmD9u/owrzempiDlBB1ZYqiLnm9s6aPc8AlFQalq2tKmqdmMr9GXOupDgzXtqnBipj8Un0gkIm7Sjf8mw==",
        bytes: 9172,
      },
      {
        name: "simple-yenc",
        version: "1.0.4",
        url: "https://registry.npmjs.org/simple-yenc/-/simple-yenc-1.0.4.tgz",
        integrity: "sha512-5gvxpSd79e9a3V4QDYUqnqxeD4HGlhCakVpb6gMnDD7lexJggSBJRBO5h52y/iJrdXRilX9UCuDaIJhSWm5OWw==",
        bytes: 8276,
      },
      {
        name: "@wasm-audio-decoders/opus-ml",
        version: "0.0.3",
        url: "https://registry.npmjs.org/@wasm-audio-decoders/opus-ml/-/opus-ml-0.0.3.tgz",
        integrity: "sha512-SEeTmk0eb3q5etJA/NHCRWW6BivTx9tqvNTmG0kg2ynuATEQRUZnwQE6Ibvl1BBvqIGHqI57+qyJMWmJBwb5XQ==",
        bytes: 6391914,
      },
      {
        name: "codec-parser",
        version: "2.5.0",
        url: "https://registry.npmjs.org/codec-parser/-/codec-parser-2.5.0.tgz",
        integrity: "sha512-Ru9t80fV8B0ZiixQl8xhMTLru+dzuis/KQld32/x5T/+3LwZb0/YvQdSKytX9JqCnRdiupvAvyYJINKrXieziQ==",
        bytes: 34315,
      },
      {
        name: "opus-decoder",
        version: "0.7.12",
        url: "https://registry.npmjs.org/opus-decoder/-/opus-decoder-0.7.12.tgz",
        integrity: "sha512-6zpHFDi/MhYvMwyYiuJPqJ2lcRkfm7wHblSvT3lUtx/kLvHkunoe/rhTn1dLKxqVGLeQj3gQi7CnR0N2p3RuOg==",
        bytes: 142208,
      },
    ],
  },
  "@wirecat/cli-core-onnx": {
    name: "@wirecat/cli-core-onnx",
    version: "1.2.0",
    packages: [
      {
        name: "@wirecat/cli-core-onnx",
        version: "1.2.0",
        url: "https://registry.npmjs.org/@wirecat/cli-core-onnx/-/cli-core-onnx-1.2.0.tgz",
        integrity: "sha512-GxiJdiu3sT2R9vw5AYXsDpQdAgjLpsnXElDFMlK2x1SNbYsrx2kPc/z/+EUuLDHL2MevngjaLnUq/TJlGVPRGg==",
        bytes: 4244099,
      },
      {
        name: "onnxruntime-common",
        version: "1.30.0",
        url: "https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.30.0.tgz",
        integrity: "sha512-7fdVWjAID1dVhH/G8qK3APARunV4VkBFoCQAP7qp4Wkab0mrorvmc+sqiT+mKXOzDqdjN5j+/Z9nb4gzNPWcyA==",
        bytes: 66795,
      },
    ],
  },
  "@huggingface/tokenizers": {
    name: "@huggingface/tokenizers",
    version: "0.2.0",
    packages: [
      {
        name: "@huggingface/tokenizers",
        version: "0.2.0",
        url: "https://registry.npmjs.org/@huggingface/tokenizers/-/tokenizers-0.2.0.tgz",
        integrity: "sha512-LidMHe1FpcSYH4vcSjXooda34pC0M8m1gmDOv7SQi6Iv+ib1zX7J3sHBCC9/3FPCkn2k1b55FneVqMRxrr99pg==",
        bytes: 87011,
      },
    ],
  },
} as const satisfies Record<string, EnginePin>
