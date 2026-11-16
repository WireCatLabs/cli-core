### Added

- **`serviceApiCommand`, the raw API of an OpenAPI service as one shared `api` group**, from notion-cli's: `api list`
  and `api show` without a request, and one command per operation of the generated manifest. A write goes through the
  profile's guard on `api.<operation>`; a delete also checks the CLI's `deleteKey` (`documents.delete`) when the
  operation is `destructive` or a `DELETE`, when a body field the operation lists in `deletingFields` is `true`
  (`in_trash`), or when the CLI's `deletingBodies` test says so. An operation may name its own key in `deleteKey`;
  neither field is in cli-base's manifest yet, so both are optional. The group refuses to build when an operation can
  delete and no delete key is set. The schemas and definitions load only when a command needs them. There is no
  free-form `api call`, no `--store-token` and no bot wording, and an operation that returns a credential is not
  offered. `--body-file` refuses a file in a WireCat tool's own folders. `serviceApiPermissions` gives the same
  operations' half of `commandPermissions`: the delete keys as `extra`, the `alsoChecks` that `--dry-run` and
  discovery show, and `ask` for each delete. A CLI wires `commandPermissions(serviceApiPermissions(api))`, merging each
  field with its own keys if it has any, and `serviceApiCommand({ ...api, app, configuration, … })`.

### Fixed

- **A sign-in's token or revoke request lost to the network is sent again**, twice at most and within its 30-second
  limit, when the failure is a failed DNS lookup (`EAI_AGAIN`, `ENOTFOUND`), a dropped or refused connection
  (`ECONNRESET`, `ECONNREFUSED`, `EPIPE`, `ETIMEDOUT`), or `hostFetch`'s `network_error`. One network blip no longer
  stops a sync with `outcome_unknown`. A provider with its own `exchange` or `revoke` keeps its own handling.
