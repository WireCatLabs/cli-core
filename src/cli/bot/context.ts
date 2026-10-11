import { CliError } from "@wirecat/cli-core"
import type { Command } from "commander"
import { pickChat } from "../../resolve.js"
import { sendGuard } from "../../sends/guard.js"
import { SendJournal } from "../../sends/journal.js"
import type { Level, PermissionKey } from "../../sends/permissions.js"
import { RecipientList } from "../../sends/recipients.js"
import { readSecret } from "../../terminal/prompt.js"
import { baseContext, environmentOf } from "../context.js"
import { terminalAsker } from "../messenger/ask.js"
import { asFirstWord } from "../profile.js"
import { botCopy } from "./copy.js"
import type { BotAdapter, BotChatRef, BotConnectOptions, BotMessenger } from "./port.js"
import { botFiles, ChatRegistry } from "./registry.js"
import { BotTokenStore } from "./token.js"

/** How the owner types this bot — `max sales bot` — so a refusal names the command that fixes it. */
export const botWords = (bot: BotMessenger, profile: string): string => `${bot.app.command} ${asFirstWord(profile)}bot`

/** What a bot command needs, resolved once: the bot's settings, its token, its lists. */
export const botContext = (command: Command, bot: BotMessenger) => {
  const base = baseContext(command, (flags, options) => bot.resolveSettings(flags, { ...options, kind: "bot" }))
  const { settings, env } = base
  const profile = settings.profile
  const files = botFiles(bot.app, profile, env)
  const tokens = bot.tokenStore?.(command, profile) ?? new BotTokenStore({ app: bot.app, profile, env })
  const words = botWords(bot, profile)
  const registry = bot.registry?.(command, profile) ?? new ChatRegistry(bot.app, profile, env)
  const recipients = () => new RecipientList(files.recipients, words)
  const journal = () => new SendJournal(files.journal)
  const connect = async (token: string, options: BotConnectOptions = {}): Promise<BotAdapter> => {
    const adapter = await bot.connect(command, token, { ...options, track: base.track })
    base.track(adapter)
    return adapter
  }
  return {
    ...base,
    profile,
    words,
    tokens,
    registry,
    recipients,
    journal,
    /** What this bot has read, sent and received, in the shared store. */
    copy: botCopy(bot.provider),
    /**
     * The profile's guard with this bot's recipient list and journal. `profile` reads as the words
     * a fix is typed with — `max sales bot recipients add …` — and a bot has no hourly limit unless
     * its section sets one.
     */
    guard: (permissionDefaults?: Readonly<Record<PermissionKey, Level>>) =>
      sendGuard({
        profile: `${asFirstWord(profile)}bot`,
        command: bot.app.command,
        readOnly: settings.readOnly,
        readOnlyFrom: settings.sources.readOnly ?? "default",
        ...(settings.readOnlyLock ? { readOnlyLock: settings.readOnlyLock } : {}),
        permissions: settings.permissions,
        permissionSources: settings.permissionSources,
        ...(permissionDefaults ? { permissionDefaults } : {}),
        permissionFix: (request, key) =>
          bot.permissionFix?.(settings, request) ??
          `${bot.app.command} ${asFirstWord(profile)}config set --bot permissions.${key} allow`,
        ask: terminalAsker(command),
        sendsPerHour: settings.sendsPerHour,
        journal: journal(),
        recipients: recipients(),
        warn: base.renderer.warn,
      }),
    /** A chat id, `user:<id>`, or the title of a chat this bot has seen — never a guess. */
    chatRef: (typed: string): BotChatRef => {
      const trimmed = typed.trim()
      if (/^-?\d+$/.test(trimmed) || /^user:\d+$/.test(trimmed)) return trimmed
      return pickChat(trimmed, registry.list()).id
    },
    readSecret: (prompt: string) => {
      const stdin = environmentOf(command).stdin
      return bot.readSecret?.(command, prompt) ?? readSecret(prompt, stdin ? { input: stdin } : {})
    },
    /** A client for this token, closed when the command ends. */
    connect,
    /** A client for the stored token, or a refusal that says how to store one. */
    authenticated: (options: BotConnectOptions = {}): Promise<BotAdapter> => {
      const stored = tokens.read()
      if (!stored) {
        throw new CliError("authentication_error", `no bot token for profile "${profile}" — run \`${words} auth set\``)
      }
      return connect(stored.token, options)
    },
  }
}

export type BotContext = ReturnType<typeof botContext>

/** `--offline` reads the local copy; a command that has to ask the messenger refuses it rather than ignoring it. */
export const online = (context: BotContext, command: Command): BotContext => {
  if (context.settings.offline) {
    throw new CliError(
      "validation_error",
      `--offline reads the local copy; \`${command.name()}\` has to ask the messenger`,
    )
  }
  return context
}
