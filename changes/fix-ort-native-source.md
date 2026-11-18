### Fixed

- **`models download` takes the native ONNX Runtime from WireCat's own npm packages.** Microsoft's GitHub repository,
  and every release download in it, answers 404 since 17.11.2026, so the download failed on Linux and macOS and the
  models ran through WebAssembly. The library now comes from `@wirecat/onnxruntime-<platform>` on npm (linux-x64,
  linux-arm64, darwin-arm64, win32-x64, win32-arm64), 10–13 MB each, with the same sha256 check of the library. No
  download depends on Microsoft's hosting any more. `bin/publish-onnxruntime` builds the packages once from
  Microsoft's NuGet package `Microsoft.ML.OnnxRuntime` 1.30.0, and on Windows from `onnxruntime-node`'s npm tarball as
  before. The Linux and Windows libraries are byte for byte the ones used so far. The macOS one is NuGet's build of
  the same version, with a new sha256. Windows downloads 11 MB instead of the 113 MB `onnxruntime-node` tarball.
