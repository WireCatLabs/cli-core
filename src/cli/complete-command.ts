import { script } from "@bomb.sh/tab"
import { CliError } from "@wirecat/cli-base"
import { annotate, describeOptions, describeProgram } from "@wirecat/cli-base/commands"
import { type CompletionSources, formatSuggestions, suggest } from "@wirecat/cli-base/completion"
import { Command } from "commander"
import type { AppIdentity } from "../ports/app.js"
import { environmentOf, outputFor } from "./context.js"
import { LOCAL_READ } from "./effects.js"
import { commandWords, liftProfile, rootOf, usableProfileName } from "./profile.js"
import type { Configuration } from "./settings.js"

const SHELLS = ["zsh", "bash", "fish", "powershell"]

/** What the words being completed name: the profile a Tab reads names for, and the words after it. */
export interface CompletionRequest {
  /** The profile typed, or the locked or session one; unset when none is usable. */
  profile: string | undefined
  words: string[]
  env: NodeJS.ProcessEnv
}

export interface AppCompletionOptions {
  /** Names for arguments and options, read locally; never a connection, and never an error a shell would show. */
  sources?: (request: CompletionRequest) => CompletionSources | undefined | Promise<CompletionSources | undefined>
}

/**
 * `<app> complete zsh` prints the script a shell sources; the script then runs `<app> complete -- <words>` on every
 * Tab, and this answers from the command registry, the profiles in the config and the CLI's own `sources`.
 *
 * ⚠ **A Tab never connects and never creates anything**, and nothing goes to stderr: a shell shows whatever it is
 * given.
 */
export const appCompleteCommand = (
  app: Pick<AppIdentity, "command" | "envPrefix">,
  config: Pick<Configuration, "configuredProfiles">,
  options: AppCompletionOptions = {},
): Command =>
  annotate(new Command("complete"), {
    literal_after_dashes: true,
    effects: LOCAL_READ,
    mcp: false,
    examples: [`${app.command} complete zsh`],
  })
    .description(`shell completion: \`${app.command} complete zsh\` prints the script to source`)
    .argument("[words...]", "zsh for the shell script, or command words to complete")
    .allowUnknownOption()
    .helpOption(false)
    .action(async function (this: Command, words: string[]) {
      const root = rootOf(this)
      const { streams } = outputFor(this)
      const env = environmentOf(this).env ?? process.env

      // Commander drops the `--` from the operands, so only the raw words tell a request from a shell name.
      const raw = (root as Command & { rawArgs: string[] }).rawArgs
      if (!raw.includes("--")) {
        if (words.includes("--help") || words.includes("-h")) this.help()
        const [shell] = words
        if (!shell || !SHELLS.includes(shell)) {
          throw new CliError("validation_error", `name a shell: ${app.command} complete ${SHELLS.join(" | ")}`)
        }
        // tab writes the script through console.log; stdout is where a `source <(…)` reads it.
        script(shell as "zsh", app.command, app.command)
        return
      }

      // The last word is still being typed, so it is never taken for a profile: `mess` is on its way to `messages`.
      const { profile, rest } =
        words.length > 1 ? liftProfile(words, commandWords(root)) : { profile: undefined, rest: words }
      const lock = env[`${app.envPrefix}_PROFILE_LOCK`]
      const wanted = profile ?? lock ?? env[`${app.envPrefix}_PROFILE`]
      const usable = wanted && readable(wanted, lock) ? wanted : undefined
      const own = await (async () => options.sources?.({ profile: usable, words: rest, env }))().catch(() => undefined)
      const suggestions = suggest({
        commands: describeProgram(root),
        globalOptions: describeOptions(root),
        words: rest.length > 0 ? rest : [""],
        sources: {
          ...(profile === undefined ? { firstWord: () => profileNames(config, env) } : {}),
          ...own,
        },
      })
      streams.data(formatSuggestions(suggestions))
    })

/** A half-typed or odd first word, or another profile than a locked one, gets no names rather than an error. */
const readable = (profile: string, lock: string | undefined): boolean => {
  if (lock && profile !== lock) return false
  try {
    usableProfileName(profile)
    return true
  } catch {
    return false
  }
}

const profileNames = (config: Pick<Configuration, "configuredProfiles">, env: NodeJS.ProcessEnv): string[] => {
  try {
    return config.configuredProfiles({ env })
  } catch {
    return []
  }
}
