### Added

- **`oauthSessionCommand` takes the sign-ins a CLI kept before**, so zm and drive can move to it with nobody signing
  in again. All new options are optional:
  - `codec` is the entry's format (`zoomTokenCodec`, `driveSessionCodec`). The standard one stays the default.
  - `legacyAccounts(env, profile)` names where older versions kept a profile's sign-in, as an account or as a service
    and an account. The first read copies it to `oauth:<provider>:<profile>`. `session end` removes it too. A run with
    moved folders only reads it.
  - `startOptions` adds options to `session start`, such as a client or the scopes to ask. `preset` reads them from
    `command.opts()`.
  - `preset` may be async. In `session start` it also gets the sign-in steps, so it can ask for a missing client id
    with `--answer-stdin`.
  - `verify` may return `extra`, which the codec saves in the entry at sign-in (drive's `principal`).
  - `afterSignIn(command, signedIn)` runs once the sign-in is kept. It gets the profile, the account and the client
    the sign-in used, so a CLI can save that client beside it (WC-SECR-25).
  - `profiles(env)` is the list `session list` names, for a CLI that keeps its profiles in its own config.
- **`session start --answer-stdin`** in every CLI built on `oauthSessionCommand`. With `--json` it asks for the
  redirected address as a `needs` line when the browser does not come back to this computer.
- **`session status` gives `expires_at`**, when the access token runs out. A refresh moves it on.
- **`session list` rows have `state`**: `saved`, `missing` or `unknown`, in `oauthSessionCommand` and
  `tokenSessionCommand`. When the keyring cannot be reached, or an entry cannot be read, the row is `signed_in: null`
  and `state: "unknown"` and the list still answers. One warning names the cause, and `session status` says more.
- **`storageOf`, `timeLimit` and `withTimeLimit` are exported** from `@wirecat/cli-core/cli`, so CLIs stop keeping
  copies of them.
- **`credentialStorage` reads an older entry under another service** (`legacyAccounts: [{ service, account }]`). It
  copies an entry it found in the private file within the file, never into the keyring. `remove` removes the older
  entries too, except in a run with moved folders, so the next read does not sign the profile in again.

### Fixed

- **`tokenSessionCommand`'s `session list` no longer fails for every profile when one sign-in cannot be read**, from
  a keyring this run cannot reach or a broken entry. That profile is `unknown` and the others are listed. WireCat
  Desktop reads its profiles from this list.
