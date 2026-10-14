import { realpathSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { Command } from "commander"
import { environmentOf } from "../context.js"
import { itemOf, renderAnswer } from "../envelope.js"
import { type McpEnvironment, serverEntry } from "../messenger/mcp-command.js"
import { nextStep } from "../steps.js"
import { botContext } from "./context.js"
import type { BotMessenger } from "./port.js"

interface Flags {
  confirmSend?: boolean
  allowDangerous?: boolean
  allowSend?: boolean
  allowDelete?: boolean
  allowModerate?: boolean
}

/** They decided which tools were offered or which writes showed a form; the profile's permissions do now. Kept so a configured agent still starts. */
const RETIRED = ["allowSend", "allowDelete", "allowModerate", "confirmSend", "allowDangerous"] as const

const withFlags = (command: Command): Command =>
  command
    .option("--confirm-send", "no longer used — writes show no form; the profile's permissions decide")
    .option("--allow-dangerous", "no longer used — writes show no form; the profile's permissions decide")
    .option("--allow-send", "no longer used — the profile's permissions decide; kept so an old setup still starts")
    .option("--allow-delete", "no longer used — the profile's permissions decide")
    .option("--allow-moderate", "no longer used — the profile's permissions decide")

const retiredNote = (flags: Flags): string | undefined => {
  const given = RETIRED.filter((flag) => flags[flag] === true)
  if (given.length === 0) return undefined
  const names = given.map((flag) => `--${flag.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`)
  return (
    `${names.join(", ")} no longer decide${given.length === 1 ? "s" : ""} anything: the bot profile's permissions do, ` +
    "and the server's status tool lists the writes they allow"
  )
}

export const commandLookup = (group: Command) => (words: readonly string[]) => {
  const found = words.reduce<Command | undefined>((at, word) => at?.commands.find((one) => one.name() === word), group)
  if (!found) return undefined
  return {
    accepts: (flag: string) => {
      for (let at: Command | null = found; at; at = at.parent)
        if (at.options.some((one) => one.long === flag)) return true
      return false
    },
  }
}

/** `bot mcp`, mounted only for a messenger that hands in its `run` on `BotMessenger.mcp`. */
export const botMcpCommand = (bot: BotMessenger): Command => {
  const { app } = bot
  const command = withFlags(
    new Command("mcp").description(
      `serve this bot to an agent over MCP, on stdin and stdout — \`claude mcp add sales-bot -- ${app.command} sales bot mcp\``,
    ),
  ).action(async function (this: Command) {
    const flags = this.optsWithGlobals<Flags>()
    const context = botContext(this, bot)
    if (!context.tokens.read()) {
      throw new CliError(
        "authentication_error",
        `no bot token for profile "${context.profile}" — run \`${context.words} auth set\``,
      )
    }
    const note = retiredNote(flags)
    if (note) context.renderer.warn(note)
    const mcp = bot.mcp
    if (!mcp || !this.parent) throw new Error("bot mcp is mounted only with BotMessenger.mcp")
    // Loaded here: every other command would otherwise pay for the SDK.
    const [{ serveBotOverStdio }, run] = await Promise.all([import("../../mcp/bot/server.js"), mcp.program()])
    await serveBotOverStdio(
      {
        bot,
        commandAt: commandLookup(this.parent),
        settings: context.settings,
        env: context.env,
        run,
        ...(mcp.tools ? { tools: mcp.tools } : {}),
        ...(mcp.skill ? { skill: mcp.skill } : {}),
      },
      context.streams.diagnostic,
    )
  })

  command.addCommand(
    withFlags(
      new Command("config").description(
        "print the mcpServers entry for Claude Desktop, Cursor and others, with full paths; writes nothing",
      ),
    ).action(function (this: Command) {
      const flags = this.optsWithGlobals<Flags>()
      const context = botContext(this, bot)
      const { renderer, settings, env } = context
      const given = environmentOf<McpEnvironment>(this).mcp ?? {}
      const entry = serverEntry(app, {
        profile: settings.profile,
        execPath: given.execPath ?? process.execPath,
        scriptPath: given.scriptPath ?? realpathSync(process.argv[1] ?? ""),
        env,
      })
      const [name, server] = Object.entries(entry.config.mcpServers)[0] as [string, { args: string[] }]
      const args = server.args.flatMap((arg) => (arg === "mcp" ? ["bot", "mcp"] : [arg]))
      const config = {
        mcpServers: { [name.replace(new RegExp(`^${app.command}`), `${app.command}-bot`)]: { ...server, args } },
      }
      renderAnswer(
        this,
        context,
        itemOf({ config }, { next: entry.nodeBound ? [nextStep("bot.mcp-config", { args: {} })] : [] }),
        () => JSON.stringify(config, null, 2),
      )
      const note = retiredNote(flags)
      if (note) renderer.warn(note)
    }),
  )
  return command
}
