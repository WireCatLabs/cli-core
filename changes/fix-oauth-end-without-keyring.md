### Fixed

- **`session end` ends a sign-in kept in the file where no keyring answers**, in every CLI built on
  `oauthSessionCommand`. It removed the sign-in, then failed with `keyring.unreachable` when it read again to check
  that nothing was left. On a server without a desktop, where the sign-in falls back to the file, it now answers
  `ended: true` and `removed: ["file"]`.
