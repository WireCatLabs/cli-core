### Added

- **`wirecat.config`'s `auth.verify`: the call that checks a token.** For `token` and `oauth2-pkce`, `{ operation, id,
  name? }` names the operation that answers whose the token is and where its answer holds the account's id and name;
  cli-template's `session start` checks a token with it.

### Changed — may break callers

- **cli-core needs `@wirecat/cli-base` 0.112.0 or later** (peer `>=0.112.0 <1.0.0`), since 0.693.0, for
  `signInRequirements` and `signInPlace`.
- **`parseCliConfig` refuses a URL that would put a secret, a space or no host into a CLI's files**: `spec.from`,
  `auth.revokeUrl` and a relay redirect take an https URL with a host and no user name, password, or key or token in
  its query. `hooks` takes a `.ts` or `.js` module under `./`. An unknown field reads "not a field of wirecat.config",
  a missing one "missing".
- **`parseCliConfig` returns `ParsedCliConfig`**, whose `source` is a plain object until `parseCrmManifest` checks it
  against the generated API.
