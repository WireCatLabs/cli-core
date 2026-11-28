import { fixtureEngine, type TarFile } from "./engine-fixtures.js"

export const VOICE_REGISTRY = "https://registry.test"

const manifest = (name: string, version: string): TarFile => ({
  path: "package/package.json",
  data: JSON.stringify({ name, version, main: "index.js" }),
})

/**
 * A stand-in for sherpa-onnx with the three files `loadSherpa` reads: a recognizer that answers `heard`, and a voice
 * detector that hands everything it was given over as one stretch of speech.
 */
const sherpaFiles = (version: string, heard: string): TarFile[] => [
  manifest("sherpa-onnx", version),
  {
    path: "package/sherpa-onnx-wasm-nodejs.js",
    data: "module.exports = (wasm) => { wasm.FS = { getStream: () => ({ nfd: 1 }) } }",
  },
  {
    path: "package/sherpa-onnx-asr.js",
    data: `class OfflineRecognizer {
  createStream() { return { acceptWaveform() {}, free() {} } }
  decode() {}
  getResult() { return { text: ${JSON.stringify(heard)} } }
  free() {}
}
module.exports = { OfflineRecognizer }`,
  },
  {
    path: "package/sherpa-onnx-vad.js",
    data: `exports.createVad = () => {
  let heard = 0
  const queue = []
  return {
    acceptWaveform(samples) { heard += samples.length },
    isEmpty() { return queue.length === 0 },
    front() { return queue[0] },
    pop() { queue.shift() },
    flush() { if (heard) queue.push({ start: 8000, samples: new Float32Array(heard) }); heard = 0 },
    reset() { heard = 0; queue.length = 0 },
    free() {},
  }
}`,
  },
]

/** A stand-in for ogg-opus-decoder: a second of quiet sound at 48 kHz, whatever the file. */
const oggFiles = (version: string): TarFile[] => [
  manifest("ogg-opus-decoder", version),
  {
    path: "package/index.js",
    data: `exports.OggOpusDecoder = class {
  constructor() { this.ready = Promise.resolve() }
  async decodeFile() { return { channelData: [new Float32Array(48000).fill(0.1)], sampleRate: 48000, samplesDecoded: 48000 } }
  free() {}
}`,
  },
]

/** The two voice engines as a test registry serves them, at `version`, the recognizer answering `heard`. */
export const voiceEngines = (version: string, heard: string) => {
  const sherpa = fixtureEngine(VOICE_REGISTRY, "sherpa-onnx", version, [
    { name: "sherpa-onnx", version, files: sherpaFiles(version, heard) },
  ])
  const ogg = fixtureEngine(VOICE_REGISTRY, "ogg-opus-decoder", version, [
    { name: "ogg-opus-decoder", version, files: oggFiles(version) },
  ])
  return {
    pins: { "sherpa-onnx": sherpa.pin, "ogg-opus-decoder": ogg.pin },
    bodies: new Map([...sherpa.bodies, ...ogg.bodies]),
  }
}

/** What `src/engines/pins.js` answers in a test that mocks it with these. */
export const VOICE_FIXTURE = voiceEngines("9.0.0", "heard by the installed engine")
