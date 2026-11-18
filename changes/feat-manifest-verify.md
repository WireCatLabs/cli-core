### Added

- **`manifestVerify` and `hostsFetch` in `@wirecat/cli-core/cli`**, so a CLI made from `wirecat.config.ts` keeps no
  token check of its own. `manifestVerify` is `tokenSessionCommand`'s `verify` from the config's `auth.verify`: it sends
  the one operation, refuses a token the answer does not call `active` (Attio answers a revoked key with 200), names a
  missing id as the service's error, and keeps the id and the name when it is text. `hostsFetch(hosts, fetch)` reaches
  only the CLI's hosts, over a test's fake when one is given.
- **`ProfileTokenStore` takes `keyring: undefined`**, so a CLI passes `baseContext`'s keyring as it is.
