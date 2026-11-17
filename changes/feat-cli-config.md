### Added

- **`@wirecat/cli-core/manifest`: `defineCli` and `parseCliConfig`, the shape of `wirecat.config.ts`.** One file names
  the CLI (command, package, environment prefix, service, owner), its API description (an https URL), its sign-in
  (`none`, `token`, or `oauth2-pkce` with the options `oauthPreset` takes), its category (cli-template's, or `other`)
  and, for a CRM, its source. cli-template's `new --from-config` builds a CLI from it. Each error names the field; the
  source is checked against the generated API by `parseCrmManifest`.
