### Fixed

- **`models download` installs the native ONNX Runtime again on Linux and macOS.** Microsoft's GitHub repository, and
  every release download in it, answers 404 since 17.11.2026, so the download failed and the models ran through
  WebAssembly. The library now comes from Microsoft's NuGet package `Microsoft.ML.OnnxRuntime` 1.30.0: one HTTP Range
  request fetches only that system's library out of the 157 MB package, 10–12.5 MB. The Linux libraries are byte for
  byte the ones from the GitHub release; the macOS one is NuGet's own build of the same version, with a new sha256.
  Windows still takes its library from `onnxruntime-node`'s npm tarball.
