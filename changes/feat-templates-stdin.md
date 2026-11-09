### Added

- **`templates edit` and `templates preview` take `--file -` to read the template from stdin.** It matches
  `digest brief edit --file -`, and lets a caller on Windows, where `/dev/stdin` does not exist, pass a template
  without a temporary file.
