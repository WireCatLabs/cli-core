### Added

- **`auth.verify.active` in `wirecat.config.ts`** names where the token check's answer says the token still works.
  Attio's `GET /v2/self` answers 200 `{ "active": false }` to an unknown, revoked or deleted token; a CLI can now
  refuse that sign-in instead of failing on a missing id.
- **`valueAt` from `@wirecat/cli-core/manifest`** reads a dotted path into an answer as the source manifest does, so
  a CLI's sign-in reads `auth.verify`'s paths the same way.

### Fixed

- **A value the service cleared clears the stored copy.** A path past the end of a list, or under a `null` the
  service sent, is now `null`, not "not sent": Attio's `values.job_title.0.value` on an empty list used to keep the
  old position ([CRM.md](../docs/dev/CRM.md#a-source-from-a-manifest)).
- **`crmManifestFake` takes its own answer when a value is one of several types.** It wrote a mapped value into a
  sample of the union's first branch, and its strict fake refused the row: every contract case of an Attio CLI
  failed.
