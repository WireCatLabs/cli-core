### Changed — may break callers

- **Search by meaning installs its engines on first use instead of shipping them.** `@wirecat/cli-core-onnx` (with
  `onnxruntime-common`) and `@huggingface/tokenizers` are no longer dependencies of the package: about 17 MB less in
  every install. The first command that loads a local model (a search, `sync --embed`, `models download`) installs
  them into `<WireCat data>/engines/` with no question, quietly under `--json` and over MCP, and goes on. When the
  install cannot run (offline, a data folder it cannot write), the search answers by words alone and names
  `<cli> models download <model>`, which installs them again; the error reason is the new `model.engine-missing`
  ([how engines install](../docs/dev/ARCHITECTURE.md#engines-installed-on-first-use)). A program that imported either
  package through cli-core's install must now depend on it itself.
