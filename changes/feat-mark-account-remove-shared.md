### Added

- **`accountRemoveCommand` is marked as cli-core's own command**, as the session and mirrors commands are since 1.2.0.
  `commands --json` gives it `origin: "cli-core"`, so the `reserved-shared-command` lint rule (WC-CMD-34) stops
  warning on the CLIs that mount it. A CLI changes it only through its options, `effects` among them: an option, a
  description or an annotation added to the returned command afterwards stops the run with
  `contract.unacknowledged-override`. Pass `{ effects }` instead of wrapping it in `annotate(...)`. The CRM's
  `account remove` does so too. No CLI on main wraps it today.
