### Changed — may break callers

- **`models ai` uses the shared command words.** `off` is now `unset` and `forget` is now `remove`. The key is
  read with `--secret-stdin` (was `--key-stdin`). Image consent is `--allow-remote` (was `--images`), given for that
  call's address and model: a `set` without it takes it back, and so does the new `models ai revoke`. `--no-images`
  is gone. memo's command lint refused the old words. 0.626.0 shipped them for one day, and only WireCat Desktop
  calls them.
