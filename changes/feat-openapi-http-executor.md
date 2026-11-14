### Added

- **`httpApiExecutor` runs a generated OpenAPI operation without a hand-written `execute`.** Give it to
  `generatedApiCommand` with the server address, the CLI's host-checked fetch, its headers (the sign-in, a pinned
  API version) and its guarded write. It fills the path, repeats an array query value, sends the JSON body and
  prints the answer. Every operation that is not a read goes through the CLI's `write`, so a level of `ask` asks and
  the journal records it; `--dry-run` previews before anything is sent. These are refused before any request: an id
  of `.` or `..`, a path that does not start with one `/`, a body that is not JSON, a multipart body, an operation
  that answers with a credential, and an undeclared host. The service's own error text is never repeated. A 401 and
  a 403 name the sign-in or the access (`auth.failed`, `access.denied`). A write that got no answer, a 5xx, or a 2xx
  whose answer cannot be read is `outcome_unknown`. `httpApiRequest` gives the request alone, for a test or a preview.
