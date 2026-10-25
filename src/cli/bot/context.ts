import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import { pickChat } from "../../resolve.js"
import { sendGuard } from "../../sends/guard.js"
import { SendJournal } from "../../sends/journal.js"
import { type Level, levelFor, type PermissionKey, readKeysForCommand } from "../../sends/permissions.js"
import { RecipientList } from "../../sends/recipients.js"
import { readSecret } from "../../terminal/prompt.js"
import { commandPathOf } from "../command-contract.js"
import { baseContext, secretInputOf } from "../context.js"
import { terminalAsker } from "../messenger/ask.js"
import { refuseUnknownPermissionKeys } from "../permission-keys.js"
import { asFirstWord } from "../profile.js"
import type { Settings } from "../settings.js"
import { botCopy } from "./copy.js"
import type { BotAdapter, BotChatRef, BotConnectOptions, BotMessenger } from "./port.js"
import { botFiles, ChatRegistry } from "./registry.js"
import { BotTokenStore } from "./token.js"

/** How the owner types this bot — `max sales bot` — so a refusal names the command that fixes it. */
export const botWords = (bot: BotMessenger, profile: string): string => `${bot.app.command} ${asFirstWord(profile)}bot`

/** What a messenger command refuses before it connects, for a bot: an unknown key, then a denied read. */
const refuseBotPermissions = (
  command: Command,
  bot: BotMessenger,
  settings: Pick<Settings, "profile" | "permissions" | "permissionSources" | "configPath" | "savedPermissions">,
): void => {
  refuseUnknownPermissionKeys(command, settings, bot.app.command)
  for (const key of readKeysForCommand(commandPathOf(command))) {
    const { level, key: named } = levelFor(settings.permissions, key)
    if (level !== "deny") continue
    throw new CliError(
      "permission_error",
      `bot profile ${settings.profile} denies ${key} (permissions.${named} is deny, from the ` +
        `${settings.permissionSources[named ?? ""] ?? "default"})`,
      { permission: key },
    )
  }
}

/** What a bot command needs, resolved once: the bot's settings, its token, its lists. */
export const botContext = (command: Command, bot: BotMessenger) => {
  const base = baseContext(command, (flags, options) => bot.resolveSettings(flags, { ...options, kind: "bot" }))
  const { settings, env, keyring } = base
  const profile = settings.profile
  const files = botFiles(bot.app, profile, env)
  const tokens =
    bot.tokenStore?.(command, profile) ??
    new BotTokenStore({ app: bot.app, profile, env, ...(keyring ? { keyring } : {}) })
  const words = botWords(bot, profile)
  refuseBotPermissions(command, bot, settings)
  const registry = bot.registry?.(command, profile) ?? new ChatRegistry(bot.app, profile, env)
  const recipients = () => new RecipientList(files.recipients, words)
  const journal = () => new SendJournal(files.journal, { service: bot.app.command, version: bot.app.version })
  const connect = async (token: string, options: BotConnectOptions = {}): Promise<BotAdapter> => {
    const adapter = await bot.connect(command, token, { ...options, track: base.track })
    base.track(adapter)
    return adapter
  }
  const noToken = () =>
    new CliError("authentication_error", `no bot token for profile "${profile}" — run \`${words} auth set\``)
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
      const known = registry.list()
      // A bot that never had a token has seen no chat, and its missing token is what needs fixing.
      if (known.length === 0 && !tokens.read()) throw noToken()
      return pickChat(trimmed, known).id
    },
    readSecret: (prompt: string) => {
      return bot.readSecret?.(command, prompt) ?? readSecret(prompt, secretInputOf(command))
    },
    /** A client for this token, closed when the command ends. */
    connect,
    /** A client for the stored token, or a refusal that says how to store one. */
    authenticated: (options: BotConnectOptions = {}): Promise<BotAdapter> => {
      const stored = tokens.read()
      if (!stored) throw noToken()
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
