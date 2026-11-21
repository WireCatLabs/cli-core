### Fixed

- **A `deny` on a service `api` call refuses it before its body is read.** A call whose key is `deny` (or
  `readonly`, for a write) answered `validation_error` (exit 2) when a required body was left out or did not match
  the schema, because every key was checked only when the call was sent. Now `api.<operation>` and each manifest key
  that does not depend on the body refuse first, with `permission_error` (exit 5) and the key in
  `details.permission`, on the command line and over MCP. A key that depends on the body is still checked once the
  body is read, and `ask` still asks there. A CLI's `before` hook on `generatedApiCommand` now runs before the flags
  are checked too.
