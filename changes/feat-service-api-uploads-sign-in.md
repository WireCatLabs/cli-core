### Added

- **A generated `api` command uploads a file's bytes.** For an operation whose body is an upload, as Petstore 3's
  `application/octet-stream` image, `--body-file <path>` (or `-` for stdin) sends the file as it is, with the
  operation's content type; such a command has no `--body`. A file in the CLI's own folders is refused, as for a JSON
  body. Needs cli-base 0.112.0, whose generator reads such a body.
- **`serviceApiOperations(manifest)`** lists the operations the `api` group offers and why it leaves out the rest, so
  a CLI's test runs exactly the commands that exist. `sendsBytes(operation)`, `readApiBytes(path)` and
  `unsendableBody(operation)` are exported beside it.
- **`serviceApiCommand` and `serviceApiCall` take no `token` for a CLI without sign-in.** Left out, no call carries a
  token, whatever the spec says; a CLI made with cli-template's `--sign-in none` passes none.

### Changed — may break callers

- **A call sends no token where the spec names no sign-in.** The `api` group and `serviceApiCall` now follow cli-base's
  `signInRequirements`: the operation's own `security`, else the document's, and nothing when neither says anything.
  Before, a manifest without `securitySchemes`, or an operation without requirements, got `Authorization: Bearer
  <token>`. A CLI whose spec omits its sign-in now gets the service's refusal (401): generate with `auth`
  (`{ securitySchemes, security, reason }`) to name it. A Discovery manifest gets its OAuth from cli-base 0.112.0's
  generator; regenerate before taking this version.
- **An operation whose body is neither JSON nor an upload's bytes, such as a multipart form, is no longer offered.**
  It always failed when run; now `api list` leaves it out and `api show <operation>` says why.
