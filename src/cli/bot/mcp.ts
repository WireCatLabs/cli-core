import { realpathSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { annotate, describeProgram } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { environmentOf } from "../context.js"
import { changesAuthorityAt, LOCAL_READ, REMOTE_WRITE, readsOverMcpAt } from "../effects.js"
import { itemOf, renderAnswer } from "../envelope.js"
import { type McpEnvironment, serverEntry } from "../messenger/mcp-command.js"
import { nextStep, rootOf } from "../steps.js"
import { botContext } from "./context.js"
import { botExamples } from "./examples.js"
import type { BotMessenger } from "./port.js"

/** `bot mcp`, mounted only for a messenger that hands in its `run` on `BotMessenger.mcp`. */
export const botMcpCommand = (bot: BotMessenger): Command => {
  const { app } = bot
  const command = annotate(new Command("mcp"), { effects: LOCAL_READ, mcp: false })
    .description(
      `serve this bot to an agent over MCP and set it up — \`claude mcp add sales-bot -- ${app.command} sales bot mcp serve\``,
    )
    .summary("serve this bot to an agent over MCP, and set that up")

  command.addCommand(
    annotate(new Command("serve"), {
      effects: REMOTE_WRITE,
      lifetime: "persistent",
      mcp: false,
      examples: botExamples(bot, "mcp serve"),
    })
      .description(
        `serve this bot to an agent over MCP, on stdin and stdout — \`claude mcp add sales-bot -- ${app.command} sales bot mcp serve\``,
      )
      .summary("serve this bot to an agent over MCP, on stdin and stdout")
      .action(async function (this: Command) {
        const context = botContext(this, bot)
        if (!context.tokens.read()) {
          throw new CliError(
            "authentication_error",
            `no bot token for profile "${context.profile}" — run \`${context.words} auth set\``,
          )
        }
        const mcp = bot.mcp
        if (!mcp) throw new Error("bot mcp is mounted only with BotMessenger.mcp")
        // Loaded here: every other command would otherwise pay for the SDK.
        const [{ serveBotOverStdio }, run] = await Promise.all([import("../../mcp/bot/server.js"), mcp.program()])
        await serveBotOverStdio(
          {
            bot,
            program: { run, commands: describeProgram(rootOf(this)) },
            authority: changesAuthorityAt(rootOf(this)),
            fetchOnly: readsOverMcpAt(rootOf(this)),
            settings: context.settings,
            levels: () => bot.resolveSettings(this.optsWithGlobals(), { env: context.env, kind: "bot" }).permissions,
            env: context.env,
            ...(mcp.keyOf ? { keyOf: mcp.keyOf } : {}),
            ...(mcp.skill ? { skill: mcp.skill } : {}),
          },
          context.streams.diagnostic,
        )
      }),
  )
  command.addCommand(
    annotate(new Command("config"), { effects: LOCAL_READ, examples: botExamples(bot, "mcp config") })
      .description("print the mcpServers entry for Claude Desktop, Cursor and others, with full paths; writes nothing")
      .summary("print the mcpServers entry for an MCP client; writes nothing")
      .action(function (this: Command) {
        const context = botContext(this, bot)
        const { settings, env } = context
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
      }),
  )
  return command
}
