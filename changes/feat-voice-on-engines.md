### Changed — may break callers

- **Voice installs its engines on first use instead of shipping them.** `sherpa-onnx` and `ogg-opus-decoder` are no
  longer dependencies of cli-core: a default install of cli-core alone takes 120 MB instead of 153 MB. The first
  transcription, Opus decoding or `models download` of a speech model installs them into the shared data folder
  (`<WireCat data>/engines`) with no question, then does its work; progress goes to stderr for a person at a terminal
  only, never under `--json` or over MCP. Offline, or when the folder cannot be written, the command fails with the
  new reason `engine.missing`, whose `details.retry` is the command that installs them
  (`<cli> <profile> models download <model>`); `messages list --transcribe` and the other reads still answer, with the
  reason under `missing`. A CLI that imported either package itself (max-cli's `src/transcribe/speech.ts` and
  `src/voice.ts`) keeps it in its own dependencies, or moves to cli-core's `decodeAudio` and `recognizeLocalPieces`
  ([how engines install](../docs/dev/ARCHITECTURE.md#engines-installed-on-first-use)).
- **The local recognizer opener may be async.** `LocalSpeechRecognizerOptions.open` may return a promise, and is
  given the engines' install options as a fourth argument; a synchronous opener, as before, still works.

### Added

- **`decodeChannels`, `decodeChannelsFile`, `decodeAudio`, `recognizeLocalPieces`, `openLocalSpeechRecognizer` and
  `transcribeOpenAI` take how the voice engines install** (`engines`: the data folder's `env`, a `fetch`, `progress`
  for stderr and the `retry` command named when they cannot be installed). Left out, they install into this
  process's data folder, silently.
- **`placeEngines` in `@wirecat/cli-core/testing`** puts the pinned engines in a test's data folder, linked to the
  copies in the repository's `node_modules`. A CLI whose tests decode Opus or run the voice detector through cli-core
  (max-cli's `src/hearing.test.ts`, whatsapp-cli's `src/media.test.ts`) adds `sherpa-onnx` and `ogg-opus-decoder` as
  dev dependencies at the pinned versions and calls `placeEngines(env, ["sherpa-onnx", "ogg-opus-decoder"])`.
