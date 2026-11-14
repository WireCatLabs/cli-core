### Fixed

- `search messages --discover` no longer reads a date or another field value written with hyphens
  (`date:2026-10-08`) as a word to look up joined: only words with letters on both sides of a hyphen are (0.664.0
  lowered a dated question's `coverage` with a made-up `20261008`).
