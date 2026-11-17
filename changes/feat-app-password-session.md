### Added

- **A service that signs in with a user name and a password, as WordPress's application passwords, gets the same
  `session` group.** `tokenSessionCommand` takes `login: { page? }`: `session start --login <name>` asks only the
  password hidden, shows where to make one first, and keeps `<name>:<password>` in the profile's entry;
  `<PREFIX>_TOKEN` holds the same pair. A manifest whose scheme is `http` `basic` now signs each call with it, where
  the `api` group refused that scheme; a token without a user name is refused before anything is sent, and a spec
  that also offers a bearer or a key sends that. A name with a colon is refused, since Basic splits there. cli-base's
  `fakeApi`, and so `crmManifestFake`, does not take Basic yet.
