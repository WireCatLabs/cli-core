import { randomUUID } from "node:crypto"
import { type CallToolResult, McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { mcpErrorResult } from "@wirecat/cli-base"
import { flatten } from "@wirecat/cli-base/commands"
import { skillResource } from "@wirecat/cli-base/skill"
import type { ErrorObject } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import type { BotMessenger } from "../../cli/bot/port.js"
import { changesMessenger } from "../../cli/effects.js"
import { itemOf } from "../../cli/envelope.js"
import { wholeList } from "../../cli/messenger/chat-answers.js"
import type { Settings } from "../../cli/settings.js"
import { MESSENGER_CHANGE_REFUSAL, readOnlyLockOf, readOnlyRefusal } from "../../ports/app.js"
import type { RunCaller } from "../../runs/run-context.js"
import type { Level, PermissionKey } from "../../sends/permissions.js"
import { type AgentAnswer, type AgentProgram, runCommandForAgent, toolsFromCommands } from "../agent.js"
import { type CallerSource, callerOf } from "../caller.js"
import { type McpCommand, normal, registerCommands } from "../surface.js"
import { agentJson } from "../text.js"
import { answered } from "../tool.js"
import { botInstructions } from "./instructions.js"

/** The CLI's own `run`, which cli-core cannot import. It must pass the whole environment it is given on. */
export type RunBotCommand = AgentProgram["run"]

export interface BotServerOptions {
  bot: BotMessenger
  /** The CLI's `run` and whole command tree; bot commands and bot-scoped configuration are discoverable. */
  program: AgentProgram
  settings: Pick<Settings, "profile" | "permissions" | "readOtherBots">
  /** The levels in force now, read before every call; `settings.permissions` when unset. */
  levels?: () => Readonly<Record<PermissionKey, Level>>
  /** The key a CLI's own bot command is guarded by, from its full path, when `keyForCommand` does not know it. */
  keyOf?: (path: readonly string[]) => PermissionKey | null | undefined
  /** Whether a command changes what a later run may do; such a command requires `mcp.authority` to execute. */
  authority?: (path: readonly string[]) => boolean
  /** Whether a command only fetches into this machine (`fetchesOnlyAt`): offered through the read tool. */
  fetchOnly?: (path: readonly string[]) => boolean
  env: NodeJS.ProcessEnv
  skill?: URL
}

/** A command's `--json` answer is already an envelope; a bare list or value is wrapped as one. */
const body = (command: string, value: unknown): object =>
  Array.isArray(value)
    ? wholeList(`bot ${command}`, value)
    : value !== null && typeof value === "object" && ("item" in value || "items" in value)
      ? value
      : itemOf(value !== null && typeof value === "object" ? value : { value })

export const createBotServer = (options: BotServerOptions) => {
  const { bot, program, settings, env } = options
  const command = bot.app.command
  const levels = options.levels ?? (() => settings.permissions)
  const authority = (path: readonly string[]) =>
    options.authority?.(path) === true || (path[0] === "config" && (path[1] === "set" || path[1] === "unset"))
  const catalogue = {
    includeUnavailable: true,
    levels: settings.permissions,
    currentLevels: levels,
    readOnly: readOnlyLockOf(bot.app, env) !== undefined,
    ...(options.keyOf ? { keyOf: options.keyOf } : {}),
    authority,
    ...(options.fetchOnly ? { fetchOnly: options.fetchOnly } : {}),
    offline: true,
    // Another bot's copy is this bot's to read only where `read_other_bots` says so.
    ...(settings.readOtherBots ? {} : { omit: ["all_bots", "bots"] }),
  }
  const tools = [
    ...toolsFromCommands(program.commands, { ...catalogue, root: ["bot"] }),
    ...toolsFromCommands(
      program.commands.filter((one) => one.path[0] === "config"),
      {
        ...catalogue,
        omit: ["bot", "personal", "defaults"],
      },
    ),
  ]
  const writes = tools
    .filter((tool) => tool.writes && tool.availability?.().available !== false)
    .map((tool) => tool.command)
  const skill = options.skill ? skillResource(bot.app, options.skill) : undefined

  // One at a time: the commands share the journal, the registry and the local copy.
  let queue: Promise<unknown> = Promise.resolve()
  const invoke = (
    path: readonly string[],
    input: Record<string, unknown>,
    caller?: RunCaller,
  ): Promise<AgentAnswer> => {
    const next = queue.then(() =>
      runCommandForAgent(program, path, path[0] === "config" ? { ...input, bot: true } : input, {
        profile: settings.profile,
        readOnly: readOnlyLockOf(bot.app, env) !== undefined,
        env,
        levels,
        ...(options.keyOf ? { keyOf: options.keyOf } : {}),
        authority,
        ...(caller ? { caller } : {}),
      }),
    )
    queue = next.catch(() => undefined)
    return next
  }

  const build = (): McpServer => {
    const callers: CallerSource = { env, client: () => server.server.getClientVersion(), connectionId: randomUUID() }
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
      tools.map((tool) => [
        tool.command,
        {
          title: tool.title,
          description: tool.description,
          writes: tool.writes,
          availability: tool.availability,
          input: tool.input,
          run: async (args, ctx) => {
            const caller = callerOf(ctx, `${command}_${tool.command.replaceAll(" ", "_")}`, callers)
            const answer = await invoke(tool.path, args, caller)
            return "error" in answer
              ? (mcpErrorResult(JSON.parse(agentJson(answer.error)) as ErrorObject) as CallToolResult)
              : answered(body(tool.command, answer.result))
          },
        } satisfies McpCommand,
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
        const auth = await invoke(["bot", "auth", "show"], {})
        const shown = "error" in auth ? auth.error : ((auth.result as { item?: unknown } | null)?.item ?? auth.result)
        return answered(
          itemOf({
            profile: settings.profile,
            kind: "bot",
            auth: shown,
            writes: tools
              .filter((tool) => tool.writes && tool.availability?.().available !== false)
              .map((tool) => tool.command),
            permissions: levels(),
          }),
        )
      },
    }
    registerCommands(
      server,
      `${command}_bot`,
      commands,
      undefined,
      (asked) => {
        const lock = readOnlyLockOf(bot.app, env)
        const one = flatten(program.commands).find(
          (info) => info.path[0] === "bot" && normal(info.path.slice(1).join(" ")) === asked,
        )
        if (lock && one && changesMessenger(one)) throw readOnlyRefusal(lock, MESSENGER_CHANGE_REFUSAL)
      },
      bot.app.messenger,
    )
    return server
  }
  return { build, tools, offered: tools.map((tool) => tool.command) }
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
