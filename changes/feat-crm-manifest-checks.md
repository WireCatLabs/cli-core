### Added

- **`crmManifestProblems(manifest, api, definitions)` checks every path a CRM manifest reads against what each
  operation answers**, from the generated `definitions`: a misspelt or moved field is named with its operation and the
  field it likely meant, before a sync runs. A part of a schema that says nothing passes.
- **A CRM manifest's `hooks.enrich`** reads more for a whole page before the map, in one batch request (HubSpot's
  associations, which its search does not answer).
- **`optional` on a manifest kind:** the service refusing it (a plan or scope without it) is a gap with the manifest's
  text and scope, and the other kinds still sync. A refusal part way through the id pass still fails it, so no unread row
  is taken as deleted. Each gap is said once per call.
- **`select.max`:** `{select}` always asks for every mapped field, then the account's own while they fit; the count left
  out is a gap, so an account with hundreds of custom fields still syncs.
