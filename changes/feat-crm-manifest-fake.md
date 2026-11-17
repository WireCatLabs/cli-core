### Added

- **`crmManifestContract` tests a CRM source from a manifest with no service code.** A CLI made from
  `wirecat.config.ts` runs every `crmSourceContract` case, faults and paging included, in one line
  ([CRM.md](../docs/dev/CRM.md#a-test-for-a-source-from-a-manifest)). Under it, `crmManifestFake` holds rows sampled
  from each answer's schema, pages them by each operation's own `pagination` and filters change reads by time;
  `crmManifestFixture` gives the source, the rows it holds and the faults `deny`, `change`, `skewed`, `sameToken`. A
  call the manifest never makes, a change read without its since and a read of an unknown id land in `refusals`.
- **`crmSourceContract` takes `held`, the ids of every row a fixture holds.** A full list must give each of them,
  and a read of changes after `change()` must leave the untouched ones out. Optional: a fixture without it runs as
  before.
