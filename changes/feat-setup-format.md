### Added

- **A CLI describes its connection flow as data, and WireCat Desktop draws it.** `defineSetup({ app, configuration,
  start, steps, texts, check })` builds a WireCat setup document (version 1) and checks it at once: every step
  reachable, every setting declared, every text in English, the reserved roles and display classes, the limits.
  `setupCommand(setup)` gives the CLI `setup show` (the document; with a profile its values, a secret only as
  `{ set: true }`), `setup apply` (`--dry-run` checks the answers on stdin per input with each setting's own schema and
  saves nothing), `setup run apply --json --answer-stdin` (Desktop's step: the CLI's check, then the settings and the
  secrets saved, nothing when the check fails) and `<profile> setup`, the same questions in the terminal. Answers on
  steps the path does not visit are dropped. The JSON Schema and three example documents are the fixture Desktop
  copies, `test/fixtures/setup-v1/`; `setupFileProblems` checks the flow's images from the CLI's own test. See
  `docs/setup.md`.
- **`settingsFor(…).settingSchema(key)`** gives one profile setting's own valibot schema, to check a single value.
