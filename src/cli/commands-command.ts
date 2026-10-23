import { CliError, EXIT_CODES, GENERIC_FAILURE } from "@wirecat/cli-base"
import { annotate, type CommandInfo, describeOptions, describeProgram } from "@wirecat/cli-base/commands"
import { CRASH_CODE } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import type { AppIdentity } from "../ports/app.js"
import { commandContract, findCommand } from "./command-contract.js"
import { environmentOf, outputFor } from "./context.js"
import { NO_EFFECTS } from "./effects.js"
import { renderDocument } from "./envelope.js"
import { commandsText } from "./help/commands-text.js"
import { rootOf } from "./profile.js"

/**
 * The major version of the JSON every command prints. The output types live in this package, so the
 * contract is this package's: raise it with a major version, when a field is removed or renamed.
 */
export const CONTRACT = 3

/**
 * The discovery surface an agent reads instead of `--help`. It opens no store, no session and no
 * settings file: which commands exist does not depend on whether this machine has logged in.
 */
export const commandsCommand = (app: AppIdentity): Command => {
  const command = annotate(new Command("commands"), { effects: NO_EFFECTS })
    .description("every command by section, one line each; --json: the contract, one path per call")
    .hook("preAction", (_command, action) => {
      if (action.optsWithGlobals<{ jsonl?: boolean }>().jsonl)
        throw new CliError("validation_error", "command discovery is one JSON object — use --json", {
          reason: "output.one-object",
        })
    })
    .argument("[path...]", "one command path, for example: search messages; inspect other groups in separate calls")
    .action(function (this: Command, path: string[]) {
      const root = rootOf(this)
      const output = outputFor(this)
      const all = describeProgram(root)
      const scoped = path.length > 0 ? scopeOf(root, all, path) : undefined
      const commands = scoped ? [scoped.command] : all
      const { json, jsonl } = this.optsWithGlobals<{ json?: unknown; jsonl?: boolean }>()

      // Asked by format, not by terminal: piped, an agent got the whole JSON tree it never asked for.
      if (json === undefined && !jsonl && !environmentOf(this).agent) {
        output.streams.data(commandsText(root, commands, scoped?.command.path).replace(/\n$/, ""))
        return
      }

      renderDocument(output, {
        cli: app.command,
        version: app.version,
        contract: CONTRACT,
        description: root.description(),
        global_options: describeOptions(root),
        ...(scoped ? { scope: scoped.command.path, inherited_options: scoped.inheritedOptions } : {}),
        commands,
        exit_codes: { ok: 0, [CRASH_CODE]: GENERIC_FAILURE, ...EXIT_CODES },
      })
    })
  command.addCommand(
    annotate(new Command("schema"), {
      effects: NO_EFFECTS,
      examples: [`${app.command} commands schema messages list`],
    })
      .description("one command's argv and result schemas, effects, permissions and retry guidance")
      .argument("<path...>", "one command path, for example: stats messages show")
      .action(function (this: Command, path: string[]) {
        renderDocument(outputFor(this), {
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
