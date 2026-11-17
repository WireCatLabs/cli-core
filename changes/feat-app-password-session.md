### Added

- **A service that signs in with a user name and a password, as WordPress's application passwords, gets the same
  `session` group.** `tokenSessionCommand` takes `login: { page? }`: `session start --login <name>` asks only the
  password hidden, shows where to make one first, and keeps `<name>:<password>` in the profile's entry. A manifest
  whose scheme is `http` `basic` now signs each call with it; before, the `api` group refused that scheme. A name with
  a colon is refused, since Basic splits there.
- **`linkedApiRoot(site, fetch, rel)` reads the API root a site names in its `Link` header**, as WordPress does with
  `rel="https://api.w.org/"`, pretty permalinks or not, and refuses one on another host.
