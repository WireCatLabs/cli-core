### Added

- **`doctor reports create` gives a pre-filled issue link** in `issue_url` and in its note, when the CLI's app
  definition names `issues`. The title and body hold only the version, the platform and the failed run's error code
  and provider key; the report file stays on the computer until the person attaches it.

### Fixed

- **`session start` and `setup` keep a provider's refusal.** A sign-in that failed for a new profile was reported as
  `profile.unknown` ("no profile named …"), hiding why the provider refused it.
- **`schedule command` saves PATH without its relative folders.** Under pnpm, PATH holds `./node_modules/.bin`, and
  `schedule exec` refused the saved schedule; a schedule saved this way runs again once it is saved again.
