### Added

- **A CRM source from a manifest: `crmSourceFromManifest(manifest, { api, call, hooks })` in `@wirecat/cli-core/crm`.**
  A CLI with an OpenAPI spec describes its CRM as data: per kind, the operations (by their generated id) that list
  every row, read changes after `{since}` (in the query or the body), list every id and read one record, and where each
  shared field sits in the answer (a path, `first`, `join`, `all`, `each`, `map`, a constant or a function). The engine
  pages by each operation's own `pagination` (or, for a change read sorted by modified time, by `keyset`: from the
  last row's time, `reset` past the service's cap), keeps `<page>@<round start>` page tokens, re-reads a 10-minute overlap,
  spends the run's budget after the first request, answers a 403 or 404 on `get` with null, asks a service that names
  its returned fields (`"{select}"`) for only the mapped ones and the account's own, and leaves out a field the answer
  did not carry, so the stored copy keeps it. Pipelines, custom field definitions and users are described the same
  way; `hooks.after` corrects one record (async, with the metered call) and `hooks.extend` adds or replaces any `CrmSource` method.
  `parseCrmManifest` checks the shape, every operation id (a read only) and every mapped field, and names the field at fault and the operation a typo
  meant. See [docs/dev/CRM.md](../docs/dev/CRM.md#a-source-from-a-manifest).
- `serviceApiCall({ manifest, service, fetch, token })` in `@wirecat/cli-core/cli`: one read operation of a generated
  manifest sent as the `api` group sends it (request, sign-in header, redirect rule, run record, refusals), for code
  that is not a command.
