### Fixed

- **`ai.address-refused` has a text of its own.** It said the same as `model.address-refused`, so cli-base's audit
  rule `same-error-reason` read them as one failure under two names and failed b24's checks
  ([#2885](https://github.com/WireCatLabs/cli-core/issues/2885)). Both ids stay: `ai.address-refused` is the AI model
  setting (`models ai set`), `model.address-refused` is a call to a model under the local-only switch.
