### Added

- **A CRM CLI built from a manifest can add notes and tasks.** `crmManifestWrites` and `crmManifestWriteCapabilities`
  take `activities`: the CLI's own functions for a comment, a task and a task marked done, and the operation each
  sends. They mount `activities create` and `activities close` under the same guard and journal as any CRM write.
  Each also checks its operation's `api` keys, so `api.<operation>: deny` stops it, and `crmAlsoChecks` takes
  `crmManifestActivityKeys` so `--dry-run` names them ([CRM](../docs/dev/CRM.md#writes-from-a-manifest)).
