import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { CliError, captureStreams, isCliError, type Streams } from "@wirecat/cli-base"
import { skillResource } from "@wirecat/cli-base/skill"
import * as v from "valibot"
import type { BotMessenger } from "../../cli/bot/port.js"
import { skipFlagFor } from "../../cli/messenger/ask.js"
import { listed } from "../../cli/paging.js"
import { DEFAULT_PROFILE } from "../../cli/profile.js"
import type { Settings } from "../../cli/settings.js"
import { keyForCommand, type Level, levelFor, type PermissionKey } from "../../sends/permissions.js"
import { type McpCommand, registerCommands } from "../surface.js"
import { answered } from "../tool.js"
import { botInstructions } from "./instructions.js"
import { BOT_TOOLS, type BotTool, type BotToolKit, type Invocation, withAcross } from "./tools.js"

/** The CLI's own `run`, which cli-messaging cannot import: each tool is one run of a bot command. */
export type RunBotCommand = (
  argv: string[],
  environment: {
    streams: Streams
    tty: false
    env: NodeJS.ProcessEnv
    answer?: (question: string) => string | null
  },
) => Promise<number>

export interface BotServerOptions {
  bot: BotMessenger
  /**
   * The mounted `bot` command at these words, and whether it (or a group above it) takes a flag —
   * a tool is offered only when its command is there.
   */
  commandAt: (words: readonly string[]) => { accepts: (flag: string) => boolean } | undefined
  settings: Pick<Settings, "profile" | "permissions" | "readOtherBots">
  env: NodeJS.ProcessEnv
  run: RunBotCommand
  /** The CLI's own tools, beside the shared ones; one with the same words replaces the shared one. */
  tools?: readonly BotTool[]
  skill?: URL
}

export const botToolName = (command: string, words: readonly string[]): string =>
  `${command}_bot_${words.join("_").replaceAll("-", "_")}`

const parsed = (text: string): unknown => {
  if (text.trim() === "") return null
  try {
    return JSON.parse(text)
  } catch {
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as unknown)
  }
}

const body = (value: unknown): object =>
  Array.isArray(value) ? listed(value) : value !== null && typeof value === "object" ? value : { value }

/**
 * Runs bot commands in this process and returns their `--json` answers. A command never sees a
 * terminal: stdin is the MCP transport. Calls are queued — they share the journal, the registry and
 * the local copy.
 */
const runner = ({ settings, run, env }: BotServerOptions) => {
  let queue: Promise<unknown> = Promise.resolve()
  const profile = settings.profile === DEFAULT_PROFILE ? [] : [settings.profile]
  const once = async (
    words: readonly string[],
    { options = [], positionals = [] }: Invocation,
    answer?: (question: string) => string | null,
  ) => {
    const streams = captureStreams()
    const argv = [...profile, "bot", ...words, ...options, "--json", "--", ...positionals]
    const code = await run(argv, { streams, tty: false, env, ...(answer ? { answer } : {}) })
    if (code === 0) return parsed(streams.stdout.join("\n"))
    const error = (parsed(streams.stderr.at(-1) ?? "") as { error?: { code?: string; message?: string } } | null)?.error
    throw new CliError(
      (error?.code ?? "generic_failure") as ConstructorParameters<typeof CliError>[0],
      error?.message ?? `the command exited with ${code}`,
      error as Record<string, unknown> | undefined,
    )
  }
  return (words: readonly string[], invocation: Invocation, answer?: (question: string) => string | null) => {
    const next = queue.then(() => once(words, invocation, answer))
    queue = next.catch(() => undefined)
    return next
  }
}

export const createBotServer = (options: BotServerOptions) => {
  const { bot, commandAt, settings } = options
  const command = bot.app.command
  const invoke = runner(options)
  const keyOf = (tool: BotTool): PermissionKey | null | undefined =>
    tool.writes ?? keyForCommand(["bot", ...tool.words])
  const levelOf = (tool: BotTool): Level => {
    const key = keyOf(tool)
    return key ? levelFor(settings.permissions, key).level : "allow"
  }
  const byName = new Map<string, BotTool>()
  for (const tool of [...BOT_TOOLS, ...(options.tools ?? [])]) byName.set(botToolName(command, tool.words), tool)
  // A tool the level would refuse is not offered: an agent is not handed a tool that cannot work.
  const offered = [...byName]
    .filter(([, tool]) => {
      const level = levelOf(tool)
      return commandAt(tool.words) !== undefined && level !== "deny" && !(tool.writes && level === "readonly")
    })
    .map(([name, tool]): [string, BotTool] => [name, tool.across && settings.readOtherBots ? withAcross(tool) : tool])
  const writes = offered.filter(([, tool]) => tool.writes).map(([, tool]) => tool.words.join(" "))

  const kit: Omit<BotToolKit, "answerFlags"> = { invoke }
  const skill = options.skill ? skillResource(bot.app, options.skill) : undefined

  /** The flag that answers the command's own question for a write at level `ask`, when the command takes it. */
  const answerFlag = (tool: BotTool): string[] => {
    const key = keyOf(tool)
    const target = commandAt(tool.words)
    if (!key || !target || levelOf(tool) !== "ask") return []
    const flag = skipFlagFor(key)
    return target.accepts(flag) ? [flag] : []
  }
  const build = (): McpServer => {
    const server = new McpServer(
      { name: `${command}-bot-${settings.profile}`, version: bot.app.version },
      {
        instructions: botInstructions({
          command,
          name: bot.name ?? command,
          profile: settings.profile,
          writes,
          ...(skill ? { skill: skill.instruction } : {}),
        }),
      },
    )
    if (skill) {
      const { uri, name, title, description, mimeType, read } = skill
      server.registerResource(name, uri, { title, description, mimeType }, read)
    }

    const commands: Record<string, McpCommand> = Object.fromEntries(
      offered.map(([, tool]) => [
        tool.words.join(" "),
        {
          title: tool.title,
          description: tool.description,
          writes: tool.writes !== undefined,
          input: tool.input,
          run: async (args, ctx) => {
            if (tool.handle)
              return answered(body(await tool.handle(args, { ...kit, answerFlags: answerFlag(tool) }, ctx)))
            const { options: own = [], positionals = [] } = tool.invocation?.(args) ?? {}
            return answered(body(await invoke(tool.words, { options: [...own, ...answerFlag(tool)], positionals })))
          },
        },
      ]),
    )
    commands.status = {
      title: "This server's bot and profile",
      description:
        "Which profile this server speaks for, where its bot token comes from, which bot it is, and which " +
        "writing commands are on. Sends nothing.",
      writes: false,
      input: v.object({}),
      run: async () => {
        const auth = await invoke(["auth", "show"], {}).catch((error: unknown) =>
          isCliError(error) ? { error: { code: error.code, message: error.message } } : { error: String(error) },
        )
        return answered({ profile: settings.profile, kind: "bot", auth, writes, permissions: settings.permissions })
      },
    }
    registerCommands(server, `${command}_bot`, commands)
    return server
  }
  return { build, offered: offered.map(([name]) => name) }
}

/** Serves until the client closes stdin or the process is told to stop; returning lets the process exit. */
export const serveBotOverStdio = async (options: BotServerOptions, note: (message: string) => void): Promise<void> => {
  const { build } = createBotServer(options)
  const handle = serveStdio(build, { onerror: (error) => note(`mcp: ${error.message}`) })
  await new Promise<void>((resolve) => {
    process.stdin.once("end", resolve)
    process.stdin.once("close", resolve)
    process.once("SIGINT", resolve)
    process.once("SIGTERM", resolve)
  })
  await handle.close()
}
