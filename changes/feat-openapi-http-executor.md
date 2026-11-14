### Added

- **`httpApiExecutor` runs a generated OpenAPI operation without a hand-written `execute`.** Give it to
  `generatedApiCommand` with the server address, the CLI's host-checked fetch, its headers (the sign-in, a pinned
  API version) and its guarded write. It fills the path, repeats an array query value, sends the JSON body and
  prints the answer. Every operation that is not a read goes through the CLI's `write`, so a level of `ask` asks and
  the journal records it; `--dry-run` previews before anything is sent. An id of `.` or `..`, a multipart body and an
  undeclared host are refused before any request. The service's own error text is never repeated, and a write that
  got no answer, or a 5xx, is `outcome_unknown`. `httpApiRequest` gives the request alone, for a test or a preview.
