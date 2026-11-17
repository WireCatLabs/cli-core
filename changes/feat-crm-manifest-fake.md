### Added

- **`crmManifestFake` and `crmManifestFixture` test a CRM source from a manifest with no service code.** Built from
  the manifest and the generated API (`@wirecat/cli-core/crm/testing`), the fake holds rows sampled from each
  answer's schema, pages them by each operation's own `pagination`, filters change reads by time and takes every
  `crmSourceContract` fault: `deny`, `change`, `skewed`, `sameToken`. A call the manifest never makes is listed in
  `refusals`. A CLI made from `wirecat.config.ts` runs the whole contract in two lines
  ([CRM.md](../docs/dev/CRM.md#a-test-for-a-source-from-a-manifest)).
