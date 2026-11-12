### Added

- **`mayRevoke(app, env, keyring?)`** says whether a sign-out may take the sign-in back at the provider. A run with a
  moved config, state or cache folder shares the owner's keyring entry and session, so it must only forget its own
  copy (WC-SECR-24). `account remove` uses it; a CLI's own `session end` calls it before it logs out at the provider.

### Changed — may break callers

- **A mistyped profile is `not_found`, with the profiles here.** A command that fails as "not signed in"
  (`authentication_error` with reason `session.missing`, `oauth.missing` or none) for a first word this computer has
  never seen as a profile now answers `not_found` with reason `profile.unknown` and `details.profiles`; the message
  keeps the sign-in hint for a profile that is new on purpose. A profile set in the environment, a bot and an MCP call
  keep the sign-in refusal.
- **Unknown commands and options carry a reason.** Commander's usage errors stay `validation_error` with the same
  text, and now give `usage.unknown-command` or `usage.unknown-option`, so a caller matches the reason, not English.

### Fixed

- **A store path SQLite cannot open is a configuration error.** A store path that is a folder, or one this user may
  not open, answered `internal_error` "this is a bug"; it now answers `configuration_error` with reason
  `store.unopenable` and the path.

### Security

- **Run records mask a Bitrix24 webhook's secret.** The segment after `/rest/<user id>/` in a URL is masked in kept
  error text and in request endpoints, as a token in a query already was.
