### Fixed

- **`crmManifestFake`'s deals name the fake's own contacts and companies**: deal n links organization n and person n,
  so a source with `linked: true` copies them and `crmManifestContract` passes over it. A linked kind's read of changes
  answers `reset` to a dead cursor, as every other kind does.
- **`sync`'s summary fits WireCat Desktop's 300 characters again.** cli-base 0.119.0 checks the limit, and every CRM
  CLI's `contracts/wirecat.json` failed to build on a 452-character summary; the activities and stage-tasks part moved
  to `help sync`.
