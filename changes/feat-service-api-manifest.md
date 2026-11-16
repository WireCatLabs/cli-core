### Added

- **`serviceApiCommand` reads the generated manifest whole** (`import * as manifest from "./generated/manifest.js"`,
  cli-base 0.108.0's `generate`): the base URL from `servers` (a variable at its default only when its `enum` lists
  it; a free one such as `{subdomain}` needs `baseUrl`, and either must be https), the sign-in header from the
  operation's `security` and the manifest's `securitySchemes` (`Authorization: Bearer`, `OAuth <token>` for an `http`
  scheme named so, an API key header that never follows a redirect; none for `security: []`, the token still sent for an
  optional sign-in), and `--all` on a read with a `pagination` and no permission key, which reads each page by its
  cursor, offset, page number or next link in one run. It ends on an empty page or the `total`, stops with an error on
  a repeated page or past 500 pages, and refuses a next link on another host, so the token never goes there. Paging by
  page number needs the first page given (`--page 0` or `1`). A CLI passes `token`, and `headers` only for what the
  scheme does not cover.
- **`linkFetch({ hosts })`** fetches a link the service returned (a download or upload URL, a signed file URL): only to
  the listed hosts, only over https, and a request carrying `authorization`, `cookie` or `proxy-authorization` is
  refused before it leaves, as is a service's own key header named in `signIn`.

### Changed — may break callers

- **`serviceApiCommand` and `serviceApiPermissions` take the manifest's `permissions`** (`<group>.delete`,
  `<group>.share`, each with the body fields or query flags that make it apply unless absent or `false`) in place of `deleteKey`,
  `deletingFields` and `deletingBodies`. A `bodyPermissions` key the manifest does not name stops the build. A key also applies to a read: a call whose flag deletes, as an upload link
  with `overwrite=true`, goes through the guard. `bodyPermissions` keeps a CLI's own test of a body, each with its key
  and a `when` for `--dry-run`. An operation that deletes without a `.delete` key in the manifest stops the build:
  generate with `permissions`. `ServiceApiOperation` and `serviceApiDeletes` are gone; `serviceApiKeys` gives the keys
  one call checks.
- **cli-base 0.108.0** is the lowest version the peer range accepts.

### Fixed

- **A generated API command's `--limit` or `--page`** (Yandex Disk's `limit`, HubSpot's) is the service's own: the CLI's paging
  settings no longer read it (in a run, a `--dry-run` preview and discovery alike), so `--page 0` or `--page 1 --all`
  is no longer refused. `withoutOwnPaging(command, flags)` leaves such flags out for a CLI's own settings call.
- **A sign-in still lands in the file when the OS keyring does not answer.** cli-base 0.108.0 reports an unreachable
  keyring as `keyring.unreachable` instead of "not signed in"; `ProfileTokenStore.write` no longer fails on it while it
  looks up the named secrets it keeps beside the token.
