import { CliError, EXIT_CODES, GENERIC_FAILURE } from "@wirecat/cli-base"
import { annotate, type CommandInfo, describeOptions, describeProgram, metaOf } from "@wirecat/cli-base/commands"
import { CRASH_CODE } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import type { AppIdentity } from "../ports/app.js"
import type { DiscoveredCommand } from "./command-availability.js"
import { commandContract, commandPathOf, findCommand } from "./command-contract.js"
import { environmentOf, outputFor } from "./context.js"
import { contractEvidence } from "./contract-evidence.js"
import { DISCOVERY_DESCRIPTIONS } from "./discovery-descriptions.js"
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
 * settings file without a named profile. A named profile adds availability without hiding commands.
 */
export const commandsCommand = (app: AppIdentity): Command => {
  const command = annotate(new Command("commands"), { effects: NO_EFFECTS })
    .description(DISCOVERY_DESCRIPTIONS.commands)
    .hook("preAction", (_command, action) => {
      if (action.optsWithGlobals<{ jsonl?: boolean }>().jsonl)
        throw new CliError("validation_error", "command discovery is one JSON object — use --json", {
          reason: "output.one-object",
        })
    })
    .argument(
      "[path...]",
      `one command path, for example: ${app.messenger === false ? "commands info" : "search messages"}; inspect other groups in separate calls`,
    )
    .action(function (this: Command, path: string[]) {
      const root = rootOf(this)
      const output = outputFor(this)
      const available = environmentOf(this).discoveryAvailability
      const annotateAvailability = (infos: readonly CommandInfo[]): DiscoveredCommand[] =>
        infos.map((info) => {
          const availability = available?.(info)
          return { ...info, ...(availability ? { availability } : {}), commands: annotateAvailability(info.commands) }
        })
      const all = annotateAvailability(describeProgram(root))
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
    annotate(new Command("info"), {
      effects: NO_EFFECTS,
      examples: [`${app.command} commands info ${app.messenger === false ? "commands" : "messages list"}`],
    })
      .description(DISCOVERY_DESCRIPTIONS.info)
      .argument("[path...]", "one command path; without one, export schemas, error reasons and explicit overrides")
      .action(function (this: Command, path: string[]) {
        renderDocument(outputFor(this), {
          cli: app.command,
          version: app.version,
          contract: CONTRACT,
          ...(path.length
            ? {
                ...commandContract(findCommand(rootOf(this), path)),
                ...(() => {
                  const found = findCommand(rootOf(this), path)
                  const availability = environmentOf(this).discoveryAvailability?.({
                    ...metaOf(found),
                    path: commandPathOf(found),
                  })
                  return availability ? { availability } : {}
                })(),
              }
            : contractEvidence(rootOf(this), app.errors ? { errors: app.errors } : {})),
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
      const groups = all
        .filter(({ name, commands }) => commands.length > 0 && name !== "commands")
        .map(({ name }) => name)
      // The groups the caller named come first: they are the list of groups this answer is most likely about.
      const [one, two] = [...new Set([...path.filter((each) => groups.includes(each)), ...groups])].map(
        (group) => `\`${root.name()} commands ${group} --json\``,
      )
      throw new CliError(
        "validation_error",
        `unknown command path "${path.join(" ")}" — inspect \`${[root.name(), "commands", ...prefix, "--json"].join(" ")}\`; ` +
          (choices.length ? `available here: ${choices.join(", ")}. ` : "this command has no subcommands. ") +
          (two
            ? `Give one command path per call, not a list of groups: ${one} and ${two} are separate calls`
            : one
              ? `Give one command path per call, such as ${one}`
              : "Give one command path per call"),
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
