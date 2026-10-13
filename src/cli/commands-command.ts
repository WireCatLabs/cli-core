import { CliError, EXIT_CODES, GENERIC_FAILURE } from "@wirecat/cli-base"
import { type CommandInfo, describeOptions, describeProgram, flatten } from "@wirecat/cli-base/commands"
import { CRASH_CODE } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import type { AppIdentity } from "./app.js"
import { commandContract, findCommand } from "./command-contract.js"
import { outputFor } from "./context.js"
import { rootOf } from "./profile.js"

/**
 * The major version of the JSON every command prints. The output types live in this package, so the
 * contract is this package's: raise it with a major version, when a field is removed or renamed.
 */
export const CONTRACT = 0

/**
 * The discovery surface an agent reads instead of `--help`. It opens no store, no session and no
 * settings file: which commands exist does not depend on whether this machine has logged in.
 */
export const commandsCommand = (app: AppIdentity): Command => {
  const command = new Command("commands")
    .description("commands, options and exit codes as JSON — inspect one command path per call")
    .argument("[path...]", "one command path, for example: search messages; inspect other groups in separate calls")
    .action(function (this: Command, path: string[]) {
      const root = rootOf(this)
      const { renderer, format } = outputFor(this)
      const all = describeProgram(root)
      const scoped = path.length > 0 ? scopeOf(root, all, path) : undefined
      const commands = scoped ? [scoped.command] : all

      if (format === "pretty") {
        renderer.result(
          flatten(commands).map(({ usage, summary, description, mutates, state }) => ({
            command: usage,
            description: summary ?? description,
            writes: mutates ? "yes" : "",
            ...(state ? { state } : {}),
          })),
        )
        return
      }

      renderer.result({
        cli: app.command,
        version: app.version,
        contract: CONTRACT,
        description: root.description(),
        globalOptions: describeOptions(root),
        ...(scoped ? { scope: scoped.command.path, inheritedOptions: scoped.inheritedOptions } : {}),
        commands,
        exitCodes: { ok: 0, [CRASH_CODE]: GENERIC_FAILURE, ...EXIT_CODES },
      })
    })
  command.addCommand(
    new Command("schema")
      .description("one command's argv and result schemas, effects, permissions and retry guidance")
      .argument("<path...>", "one command path, for example: stats messages show")
      .action(function (this: Command, path: string[]) {
        const { renderer } = outputFor(this)
        renderer.result({
          cli: app.command,
          version: app.version,
          contract: CONTRACT,
          ...commandContract(findCommand(rootOf(this), path)),
        })
      }),
  )
  return command
}

const scopeOf = (root: Command, all: CommandInfo[], path: string[]) => {
  let parent = root
  let available: readonly CommandInfo[] = all
  let selected: CommandInfo | undefined
  const inheritedOptions: { path: readonly string[]; options: ReturnType<typeof describeOptions> }[] = []
  for (const word of path) {
    const child = parent.commands.find((command) => command.name() === word || command.aliases().includes(word))
    const described = child && available.find(({ name }) => name === child.name())
    if (!child || !described) {
      const prefix = selected?.path ?? []
      const choices = available.map(({ name }) => name)
      throw new CliError(
        "validation_error",
        `unknown command path "${path.join(" ")}" — inspect \`${[root.name(), "commands", ...prefix, "--json"].join(" ")}\`; ` +
          (choices.length ? `available here: ${choices.join(", ")}. ` : "this command has no subcommands. ") +
          `Give one command path per call, not a list of groups: \`${root.name()} commands messages --json\` ` +
          `and \`${root.name()} commands chats --json\` are separate calls`,
        { path, at: word, available: choices },
      )
    }
    if (selected && selected.options.length > 0) {
      inheritedOptions.push({ path: selected.path, options: [...selected.options] })
    }
    selected = described
    parent = child
    available = described.commands
  }
  return { command: selected as CommandInfo, inheritedOptions }
}
