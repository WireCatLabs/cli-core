### Added

- **`@wirecat/cli-core/manifest`: `defineCli` and `parseCliConfig`, the shape of `wirecat.config.ts`.** One file names
  the CLI (command, package, prefix, provider, service, owner), its API description, its sign-in (`none`, `token`, or
  `oauth2-pkce` with its scopes and redirect), its category and, for a CRM, its source. cli-template's
  `new --from-config` builds a CLI from it. Each error names the field; the source is checked against the generated
  API by `parseCrmManifest`.
