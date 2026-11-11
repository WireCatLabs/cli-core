import { existsSync } from "node:fs"
import { singleLine } from "@wirecat/cli-base"
import type { CompletionSources, Suggestion } from "@wirecat/cli-base/completion"
import type { Command } from "commander"
import type { Chat } from "../../domain/models.js"
import { storePath } from "../../store/path.js"
import { openStore } from "../../store/store.js"
import { appCompleteCommand } from "../complete-command.js"
import type { Configuration } from "../settings.js"
import { recalledAccount } from "./accounts.js"
import type { Messenger } from "./context.js"

export interface CompletionOptions {
  account?: (profile: string, env: NodeJS.ProcessEnv) => string | undefined
  sources?: (profile: string, words: string[], env: NodeJS.ProcessEnv) => CompletionSources | undefined
}

/**
 * `tg complete zsh`, as `appCompleteCommand` answers it, with the profile's chats and people from the message store
 * if it exists — no store, no names.
 */
export const completeCommand = (
  messenger: Messenger,
  config: Pick<Configuration, "configuredProfiles">,
  options: CompletionOptions = {},
): Command =>
  appCompleteCommand(messenger.app, config, {
    sources: async ({ profile, words, env }) => {
      if (!profile) return undefined
      const custom = options.sources?.(profile, words, env)
      if (custom) return custom
      const account = accountOf(messenger, profile, env, options)
      const store = account && existsSync(storePath(env)) ? await openStore({ env }).catch(() => undefined) : undefined
      if (!store || !account) return sourcesFrom([], [])
      try {
        // Read up front: `suggest` asks its sources synchronously, and the store answers asynchronously.
        const chats = (await store.chats.chats(account, { limit: 500 })).items
        const people = (await store.people.people(account.provider, { account: account.account })).all()
        const known = new Map(
          people.map((person) => [person.id, { value: person.id, description: singleLine(person.name ?? "") }]),
        )
        for (const chat of chats.filter((chat) => chat.kind === "dialog")) {
          const id = messenger.partnerOf ? messenger.partnerOf(chat) : chat.id
          if (id !== undefined && !known.has(id))
            known.set(id, { value: id, description: singleLine(chat.title ?? "") })
        }
        return sourcesFrom(chats, [...known.values()])
      } finally {
        await store.close()
      }
    },
  })

const accountOf = (messenger: Messenger, profile: string, env: NodeJS.ProcessEnv, options: CompletionOptions) => {
  if (!options.account) return recalledAccount(messenger.app, messenger.provider, profile, env)
  const id = options.account(profile, env)
  return id === undefined ? undefined : { provider: messenger.provider, account: id }
}

const sourcesFrom = (stored: Chat[], people: Suggestion[]): CompletionSources => {
  const chats = () => chatSuggestions(stored)
  const persons = () => people
  return { arguments: { chat: chats, person: persons }, options: { chat: chats } }
}

/**
 * **Ids only, never a title as the word.** bash's `compgen -W` expands `$(…)` in every word it is
 * given, and a title is whatever somebody else typed — so the id is the word, and the title rides
 * along as a description, on one line: bash splits the answer on newlines.
 */
const chatSuggestions = (chats: Chat[]): Suggestion[] =>
  chats.map((chat) => ({ value: chat.id, description: singleLine(chat.title ?? "") }))
