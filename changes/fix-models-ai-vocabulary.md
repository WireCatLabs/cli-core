### Changed — may break callers

- **`models ai` uses the shared command words.** `off` is now `unset` and `forget` is now `remove`. The key is
  read with `--secret-stdin` (was `--key-stdin`). Image consent is `--allow-remote` (was `--images`), given for that
  call's address and model: a `set` without it takes it back, and so does the new `models ai revoke`. `--no-images`
  is gone. memo's command lint refused the old words. 0.626.0 shipped them for one day, and only WireCat Desktop
  calls them.

### Added

- **`aiTextReader` in `@wirecat/cli-core/documents`** sends text to the model chosen with `models ai set`, with the
  key kept for that address. It says `ai.not-set` or `ai.key-missing` when it cannot, and whether the text leaves this
  computer. memo's `ai-model` source reader uses it, so one key and one model serve images and text.
