### Fixed

- **`crmManifestFake` answers within the schema when a value is one of several shapes**, as Attio's 17 typed values
  are. A mapped path inside a `oneOf` or `anyOf` is written into the branch that has it, and whose leaf takes the
  value; before, it went into a sample of the first branch, and the strict fake refused its own answer.
- **A mapped path past the end of a list is empty to its end.** `values.job_title.0.value` on `job_title: []` read
  "not sent", so a cleared title, name or domain stayed in the copy; it now reads empty and clears it.

### Added

- **`valueAt(value, path)` in `@wirecat/cli-core/crm`**: the dotted path reader the manifest's map uses, for a
  CLI's own code such as the config template's `auth.verify`.
