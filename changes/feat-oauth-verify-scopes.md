### Added

- **`oauthSessionCommand` hands `verify` the scopes the service granted**, as a fourth argument, in `session start`
  and in `session status --check`. An account may untick a scope on the consent screen and still sign in, so a CLI
  can now refuse such a sign-in before it is kept (gcal refuses one without read access to Calendar, or without a
  grant it asked for). A `verify` that takes three arguments works as before.
