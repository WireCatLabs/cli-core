### Added

- **`appDoctorCommand` for a CLI with no profiles.** memo has its own config file and no accounts, so it kept a copy of
  the shared doctor. `configuration` may now be `null`, with `config(env, command)` giving the config's `path`, `found`
  and `issues`, and `profiles` is then `null`. `local` receives the command, may be async, and returns `failing: true`
  to make doctor exit 1. `view(item)` gives the text a person reads. The CLI's `local` fields win over the shared ones
  of the same name, and a note the shared check and the CLI both print is printed once.
- **`setExitCode` is exported from `@wirecat/cli-core/cli`.** A command that answers and still fails (a sync with
  failed sources) sets this run's exit code, also under `commands --serve`, where several requests share one process.
