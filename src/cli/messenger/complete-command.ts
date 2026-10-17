import { existsSync } from "node:fs"
import { script } from "@bomb.sh/tab"
import { CliError, singleLine } from "@wirecat/cli-base"
import { annotate, describeOptions, describeProgram } from "@wirecat/cli-base/commands"
import { type CompletionSources, formatSuggestions, type Suggestion, suggest } from "@wirecat/cli-base/completion"
import { Command } from "commander"
import type { Chat } from "../../domain/models.js"
import { envName } from "../../ports/app.js"
import { storePath } from "../../store/path.js"
import { openStore } from "../../store/store.js"
import { environmentOf, outputFor } from "../context.js"
import { LOCAL_READ } from "../effects.js"
import { commandWords, liftProfile, rootOf, usableProfileName } from "../profile.js"
import type { Configuration } from "../settings.js"
import { recalledAccount } from "./accounts.js"
import type { Messenger } from "./context.js"

const SHELLS = ["zsh", "bash", "fish", "powershell"]

export interface CompletionOptions {
  account?: (profile: string, env: NodeJS.ProcessEnv) => string | undefined
  sources?: (profile: string, words: string[], env: NodeJS.ProcessEnv) => CompletionSources | undefined
}

/**
 * `tg complete zsh` prints the script a shell sources; the script then runs `tg complete -- <words>`
 * on every Tab, and this answers from the command registry.
 *
 * ⚠ **A Tab never connects and never creates anything.** Names come from the message store if it
 * exists — no store, no names — and nothing goes to stderr: a shell shows whatever it is given.
 */
export const completeCommand = (
  messenger: Messenger,
  config: Pick<Configuration, "configuredProfiles">,
  options: CompletionOptions = {},
): Command =>
  annotate(new Command("complete"), { effects: LOCAL_READ, mcp: false })
    .description(`shell completion: \`${messenger.app.command} complete zsh\` prints the script to source`)
    .argument("[words...]")
    .allowUnknownOption()
    .helpOption(false)
    .action(async function (this: Command, words: string[]) {
      const { app } = messenger
      const root = rootOf(this)
      const { streams } = outputFor(this)
      const env = environmentOf(this).env ?? process.env

      // Commander drops the `--` from the operands, so only the raw words tell a request from a shell name.
      const raw = (root as Command & { rawArgs: string[] }).rawArgs
      if (!raw.includes("--")) {
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
      const lock = env[envName(app, "PROFILE_LOCK")]
      const wanted = profile ?? lock ?? env[envName(app, "PROFILE")]
      const custom = wanted && readable(wanted, lock) ? options.sources?.(wanted, rest, env) : undefined
      const account =
        wanted && !custom && readable(wanted, lock) ? accountOf(messenger, wanted, env, options) : undefined
      const store = account && existsSync(storePath(env)) ? await openStore({ env }).catch(() => undefined) : undefined
      try {
        // Read up front: `suggest` asks its sources synchronously, and the store answers asynchronously.
        const chats = store && account ? (await store.chats.chats(account, { limit: 500 })).items : []
        const people =
          store && account ? (await store.people.people(account.provider, { account: account.account })).all() : []
        const known = new Map(
          people.map((person) => [person.id, { value: person.id, description: singleLine(person.name ?? "") }]),
        )
        for (const chat of chats.filter((chat) => chat.kind === "dialog")) {
          const id = messenger.partnerOf ? messenger.partnerOf(chat) : chat.id
          if (id !== undefined && !known.has(id))
            known.set(id, { value: id, description: singleLine(chat.title ?? "") })
        }
        const suggestions = suggest({
          commands: describeProgram(root),
          globalOptions: describeOptions(root),
          words: rest.length > 0 ? rest : [""],
          sources: {
            ...sourcesFrom(chats, [...known.values()], profile === undefined, () => profileNames(config, env)),
            ...custom,
          },
        })
        streams.data(formatSuggestions(suggestions))
      } finally {
        await store?.close()
      }
    })

const accountOf = (messenger: Messenger, profile: string, env: NodeJS.ProcessEnv, options: CompletionOptions) => {
  if (!options.account) return recalledAccount(messenger.app, messenger.provider, profile, env)
  const id = options.account(profile, env)
  return id === undefined ? undefined : { provider: messenger.provider, account: id }
}

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

const sourcesFrom = (
  stored: Chat[],
  people: Suggestion[],
  atTheStart: boolean,
  profiles: () => string[],
): CompletionSources => {
  const chats = () => chatSuggestions(stored)
  const persons = () => people
  return {
    arguments: { chat: chats, person: persons },
    options: { chat: chats },
    ...(atTheStart ? { firstWord: profiles } : {}),
  }
}

/**
 * **Ids only, never a title as the word.** bash's `compgen -W` expands `$(…)` in every word it is
 * given, and a title is whatever somebody else typed — so the id is the word, and the title rides
 * along as a description, on one line: bash splits the answer on newlines.
 */
const chatSuggestions = (chats: Chat[]): Suggestion[] =>
  chats.map((chat) => ({ value: chat.id, description: singleLine(chat.title ?? "") }))

const profileNames = (config: Pick<Configuration, "configuredProfiles">, env: NodeJS.ProcessEnv): string[] => {
  try {
    return config.configuredProfiles({ env })
  } catch {
    return []
  }
}
