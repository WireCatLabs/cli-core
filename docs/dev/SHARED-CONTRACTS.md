# Shared CLI contracts

Public command factories in `@wirecat/cli-core/cli` and `@wirecat/cli-core/meetings/cli`
protect their definitions before returning them to a host. The guards live in
`@wirecat/cli-base/commands`, beside the command registry. Providers bind adapters,
capabilities and I/O, and inherit the resulting grammar and output metadata.

`createProgram` validates after host configuration. Protected commands also validate before
an action. Silent changes to arguments, options, aliases, output, query fields, effects,
examples or help fail with `contract.unacknowledged-override`. Removing an inherited child
also fails. A provider may add its own commands to an inherited group.

Use an explicit override before changing an inherited definition:

```ts
import { overrideSharedContract, tasksCommand } from "@wirecat/cli-core/cli"

const tasks = tasksCommand(messenger)
overrideSharedContract(tasks, "This provider reads stored tasks and has no background scanner.", command => {
  command.description("stored tasks")
})
```

The callback must change the named command. A reason must explain the provider requirement;
empty edits, vague reasons shorter than ten characters and retrospective exemptions fail.
A later edit needs another explicit override. Overrides do not grant permissions or change
output validation. Action implementations still pass through the host's ordinary runtime guards.

A standalone CLI with an independent source or transport binds its deliberate variation before
construction with `customizeSharedCommand(reference, reason, build, expectedOverrides)`. Use a real shared factory
as the reference, or `sharedCommandTemplate(app, name)` for a construction-only standard shell.
Templates cannot execute. `expectedOverrides` is a static, reviewed list of exact command paths,
fields, before/after values and reasons, checked against the actual definitions before installing
guards. Keep it in source control; never derive it automatically during construction. Missing, stale
or additional differences fail. A new Core default therefore requires an explicit review, including
when an independent builder omits it. The accepted result is guarded against subsequent edits. A builder cannot use it to acknowledge
an already changed protected command. Provider-only extensions remain possible.

`commands info --json` exports original core definitions, exact accepted before/after edits,
shared and registered provider schemas, and the effective error-reason registry. A provider
with its own program shell installs `addContractInfo` and calls `assertSharedContracts` after
composition. Projection-only declarations remain labelled in `field_only`; they do not claim
that a payload's types were validated.

Use `modelCatalogueCommand` for a standalone CLI's `models list` and `models download`.
Choose its supported kinds and inject environment, output, diagnostics and offline policy.
The factory owns native queries, receipts and verified installation.

The complete cross-CLI audit checks the exported references separately from ordinary lint
baselines. Supply the canonical `parity.json` with `--capabilities` to recognize declared
provider availability differences; the observed command and option presence must match it
exactly. Other reviewed differences require exact current values and a reason. A historical
baseline cannot authorize a changed shared contract.
