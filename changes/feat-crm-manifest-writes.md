### Added

- **CRM writes described by a source manifest.** `writes.<kind>` names a service's create, update and remove calls
  and how each of our fields is sent (`to`, `each`, `list`, `number`, `decimals`, `implied`, a fixed currency,
  `clear`), so a CRM CLI built from `wirecat.config.ts` gets `deals create|update|move|close|delete` and
  `people create|update` with no writer of its own. A field with no rule, and a `--field` code the service does not
  define, are refused before anything is sent. `crmManifestWrites` builds
  `CrmRun.writes` over the CLI's fetch and token, and each write also checks its operation's `api` keys;
  `crmManifestWriteCapabilities` and `crmManifestWriteKeys` give `addCrmCommands` and `crmAlsoChecks` the same.
  `crmManifestWriteContract` runs `crmWriteContract` against `crmManifestFake`, which now answers writes, with
  `loseNextAnswer()` and `requests()` ([CRM.md](../docs/dev/CRM.md#writes-from-a-manifest)).
- **`crmSourceFromManifest` reads one record of any kind**: `record(kind, id)` by the entity's `get`, as a writer's
  read-back.
- **attio in "Works with".** `WIRECAT_TOOLS` lists `attio` (`@wirecat/attio-cli`) beside the other CRM CLIs.
