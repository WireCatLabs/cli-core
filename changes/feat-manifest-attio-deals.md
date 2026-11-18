### Added

- **A CRM source from a manifest reads a pipeline answered as a flat list of stages** (`stages.each: "."`, grouped by
  `stages.pipeline` or one pipeline), and a hook `pipelines.<kind>.outcome` decides a stage's outcome the data cannot
  say. Attio's deal stages and Pipedrive's `/stages` answer this way.
- **`custom.typed` reads the account's own fields from typed entries with their history**, as Attio keeps them: the
  current entry's value by its type (`TYPED_VALUE_PATHS`, overridable), a multiple field or several current entries as a list.
  `fields.keep` takes `{ path, is }`, so a config file can say which fields are the account's own.
- **`entities.person.search` and `entities.organization.search` give a manifest source a live `list`**, for `people
  list` and `organizations list`: words through the search call's `"{query}"`, none through `list`. A condition it
  cannot send is refused, not dropped; a live list pages by offset, so a cursor-paged search is refused.
- `hooks.extend` gets the service's `call` as its second argument.

### Fixed

- `crmManifestFake` matches a call whatever page size and offset the source asked for, a live list setting its own, and writes a stage's won or lost flag as a boolean or a word, as its schema takes it.
