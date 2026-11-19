### Changed — may break callers

- **An old flat `api` key is refused, not honoured: rename it to the key the refusal names.** A config that still names
  `api.contacts-list` after the generated `api` group put that command under `api contacts list` no longer has the key
  checked beside the new one. Every command refuses to run, `mcp serve` refuses to start, and `config set` refuses the
  key, each with `configuration_error` or `validation_error` saying "its command moved, so rename it to
  permissions.api.contacts.list". A moved path keeps no alias, its key included (WC-CMD-8). Until a CLI regenerates
  with groups, no key moved and nothing changes.
