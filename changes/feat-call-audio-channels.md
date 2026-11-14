### Added

- **Recordings that ffmpeg reads keep their channels.** `decodeChannels` gives a stereo WAV, GSM, AAC or M4A call
  two channels, one speaker each, as it already did for MP3, Ogg and FLAC. A mono file stays one channel, and a file
  of more channels is mixed down to two. Each channel still stops at an hour of audio, and ffmpeg's output is split
  into channels as it arrives, so the interleaved samples are never held whole. `decodeChannelsFile(path, { maxBytes })`
  hands a WAV or GSM file to ffmpeg by its path, so a recording of gigabytes is not read into memory first;
  `runFfmpegFile(path)` is the step under it, and `mixDown` averages channels into one.
- **`cloudSpeech` lets a host send a profile's recordings to an OpenAI-compatible speech-to-text, when that profile
  asks.** It is `null` unless the profile's own settings say `transcribeWith: "openai"`. The audio goes to OpenAI, or
  to the address the shared AI model is set to (`models ai set openai --base-url … --secret-stdin`), with the key
  kept for that address. The model is the profile's `transcribeModel` (`gpt-transcribe` when not set). The host's
  `notify` gets one line naming the host before the first audio leaves the computer. It refuses in a read-only
  process, with local only on, and without a key (`transcription.no-key`, naming the command that sets it). Long
  audio goes in pieces of at most ten minutes, under the provider's 25 MB limit. See
  [MEETING-PROVIDERS.md, "Decoding a recording, and cloud speech"](../docs/dev/MEETING-PROVIDERS.md#decoding-a-recording-and-cloud-speech).
- `transcribeOpenAI` takes `label` and `keyHint`, so a compatible service's errors name that service and the command
  that sets its key, not OpenAI. A compatible server on this computer needs no key.

### Changed — may break callers

- **`Ffmpeg` (the seam of `decodeChannels` and `decodeAudio`) may answer `Pcm[]`, one per channel,** and `runFfmpeg`
  now does. A seam that still answers one `Pcm` works, and `decodeChannels` then says `mixed: true`. `mixed` is no
  longer true for every file ffmpeg read.
- **`decodeAudio` mixes every channel into one,** where it gave the first channel of a stereo MP3, Ogg or FLAC. A
  stereo voice message or audio file now keeps both sides in its one text.
