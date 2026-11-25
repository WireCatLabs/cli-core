### Added

- **`tokenSessionCommand`, `oauthSessionCommand` and `fileMirrorsCommand` are marked as cli-core's own commands**,
  as `appDoctorCommand` is. `commands --json` gives them `origin: "cli-core"`, so the `reserved-shared-command` lint
  rule (WC-CMD-34) stops warning on the CLIs that mount them. A CLI changes them only through their options: an
  option, a description or an annotation added to the returned command afterwards stops the run with
  `contract.unacknowledged-override`. No CLI does that today.
- **`accountRemoveCommand` takes `effects`.** A CLI whose removal reaches no service passes `LOCAL_WRITE` here,
  instead of annotating the returned command. asterisk, beeline, notion and yandex-disk annotate it today, so
  `accountRemoveCommand` stays unmarked until they pass `effects`.
