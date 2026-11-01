import type { Readable, Writable } from "node:stream"
import { type CallToolResult, McpServer } from "@modelcontextprotocol/server"
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio"
import { CliError, mcpErrorResult } from "@wirecat/cli-base"
import { describeProgram } from "@wirecat/cli-base/commands"
import { skillResource } from "@wirecat/cli-base/skill"
import type { ErrorObject } from "@wirecat/cli-base/standards"
import { type BaseContext, environmentOf } from "../cli/context.js"
import { changesAuthorityAt, judgedTargets, readsOverMcpAt } from "../cli/effects.js"
import { DEFAULT_OUTPUT_BYTES } from "../cli/execution.js"
import type { CommandPermissions } from "../cli/permission-keys.js"
import type { GlobalFlags, ResolveOptions, Settings } from "../cli/settings.js"
import { rootOf } from "../cli/steps.js"
import { mcpUrlOf } from "../http/public-url.js"
import { type AppIdentity, readOnlyLockOf } from "../ports/app.js"
import { type AgentProgram, type CommandAvailability, runCommandForAgent, toolsFromCommands } from "./agent.js"
import type { HttpOptions } from "./http/serve.js"
import { mcpHttpMarker } from "./http/state.js"
import { appInstructions } from "./instructions.js"
import { envelope, PER_RUN } from "./server.js"
import { answeredWire } from "./stdio-wire.js"
import { type McpCommand, registerCommands } from "./surface.js"
import { agentJson } from "./text.js"
import { answered, failed } from "./tool.js"

/** The `mcp serve` command running the server; named so, since a module here never imports commander. */
type Command = Parameters<typeof rootOf>[0]

/** What the shared MCP server needs of a CLI that is not a messenger. */
export interface AppServerOptions {
  app: AppIdentity
  /** `Google Calendar`. */
  name: string
  /** The kinds of text other people wrote that the answers carry (WC-MCP-11). */
  untrusted: readonly [string, ...string[]]
  resolveSettings: (flags: GlobalFlags, options?: ResolveOptions) => Settings
  /** The CLI's own keys and defaults (`configuration.permissions`). */
  permissions?: CommandPermissions | undefined
  /** The CLI's SKILL.md, served as a resource. */
  skill?: URL
  /**
   * What the CLI alone knows stops a command for this profile — drive's OAuth grant that lacks a scope. Asked on every
   * call and every search, after the permissions; `undefined` leaves the permissions' answer.
   */
  availability?: (path: readonly string[], profile: string) => CommandAvailability | undefined
}

/** `mcp` itself is left out: an agent cannot start a server from inside one. */
const EXCLUDED = [["mcp"]]

/**
 * Every command of the program is a tool, run in this process through the CLI's own `run` — the same parsing,
 * permissions, guard and answer as on the command line. A fresh server per `build`, as `serveStdio` and each HTTP
 * session ask; they share nothing a call could leave behind.
 */
export const createAppServer = (command: Command, context: BaseContext, options: AppServerOptions) => {
  const { app } = options
  const root = rootOf(command)
  const environment = environmentOf(command)
  if (!environment.runCommand) throw new Error("the MCP server runs inside run(), which hands it the program")
  const program: AgentProgram = { run: environment.runCommand, commands: describeProgram(root) }
  const flags = command.optsWithGlobals<GlobalFlags & { permission?: string[] }>()
  const overrides = flags.permission ?? []
  const { settings } = context
  const levels = () => options.resolveSettings(flags, { env: context.env }).permissions
  const readOnly = () => readOnlyLockOf(app, context.env) !== undefined
  const authority = changesAuthorityAt(root)
  const targets = judgedTargets(root)
  const passed = Object.fromEntries(Object.entries(environment).filter(([key]) => !PER_RUN.has(key)))
  const tools = toolsFromCommands(program.commands, {
    includeUnavailable: true,
    exclude: EXCLUDED,
    levels: settings.permissions,
    currentLevels: levels,
    readOnly: readOnly(),
    authority,
    fetchOnly: readsOverMcpAt(root),
    permissions: options.permissions,
  })
  const availability = (one: (typeof tools)[number]) => (): CommandAvailability => {
    const permitted = one.availability?.() ?? { available: true }
    if (!permitted.available) return permitted
    return options.availability?.(one.path, settings.profile) ?? permitted
  }
  const commands: Record<string, McpCommand> = Object.fromEntries(
    tools.map((one) => [
      one.command,
      {
        title: one.title,
        description: one.description,
        writes: one.writes,
        availability: availability(one),
        input: one.input,
        run: async (input, ctx): Promise<CallToolResult> => {
          const own = options.availability?.(one.path, settings.profile)
          if (own && !own.available)
            return failed(
              new CliError("permission_error", `${one.command}: ${own.reason ?? "unavailable for this profile"}`, {
                ...(own.permission ? { permission: own.permission } : {}),
              }),
              app.errors,
            )
          const traceparent = ctx?.mcpReq?._meta?.traceparent
          const env = typeof traceparent === "string" ? { ...context.env, TRACEPARENT: traceparent } : context.env
          const answer = await runCommandForAgent(program, one.path, input, {
            profile: settings.profile,
            readOnly: readOnly(),
            env,
            levels,
            overrides,
            authority,
            permissions: options.permissions,
            environment: passed,
          })
          if ("error" in answer)
            return mcpErrorResult(JSON.parse(agentJson(answer.error)) as ErrorObject) as CallToolResult
          try {
            return answered(envelope(one.command, answer.result), DEFAULT_OUTPUT_BYTES, targets)
          } catch (error) {
            return failed(error, app.errors)
          }
        },
      },
    ]),
  )
  const skill = options.skill ? skillResource(app, options.skill) : undefined
  const build = (): McpServer => {
    const server = new McpServer(
      { name: app.command, version: app.version },
      {
        instructions: appInstructions({
          command: app.command,
          name: options.name,
          profile: settings.profile,
          untrusted: options.untrusted,
          ...(skill ? { skill: skill.instruction } : {}),
        }),
      },
    )
    registerCommands(server, app.command, commands, app.errors, undefined, app.messenger)
    if (skill) {
      const { uri, name, title, description, mimeType, read } = skill
      server.registerResource(name, uri, { title, description, mimeType }, read)
    }
    return server
  }
  return { build, offered: Object.keys(commands) }
}

/** Serves until the client closes stdin or the process is told to stop. */
export const serveAppOverStdio = async (
  command: Command,
  context: BaseContext,
  options: AppServerOptions,
): Promise<void> => {
  const { build } = createAppServer(command, context, options)
  const { stdin, stdout, signal } = environmentOf(command)
  const own = stdin && stdout && stdin !== process.stdin
  const wire = answeredWire((own ? stdin : process.stdin) as Readable, (own ? stdout : process.stdout) as Writable)
  const handle = serveStdio(build, {
    transport: new StdioServerTransport(wire.input, wire.output),
    onerror: (error) => context.renderer.note(`mcp: ${error.message}`),
  })
  const ended = await new Promise<"input" | "stopped">((resolve) => {
    wire.ended.then(() => resolve("input"))
    if (own) signal?.addEventListener("abort", () => resolve("stopped"), { once: true })
    else {
      process.once("SIGINT", () => resolve("stopped"))
      process.once("SIGTERM", () => resolve("stopped"))
    }
  })
  if (ended === "input") await wire.answered()
  wire.release()
  await handle.close()
}

/** The same server over HTTP, until Ctrl-C. */
export const serveAppOverHttp = async (
  command: Command,
  context: BaseContext,
  options: AppServerOptions,
  http: Omit<HttpOptions, "onCode" | "onError" | "appName">,
): Promise<void> => {
  const { app } = options
  const { build } = createAppServer(command, context, options)
  const { serveOverHttp } = await import("./http/serve.js")
  const listening = await serveOverHttp(build, {
    ...http,
    appName: app.command,
    onCode: (code, expires) =>
      context.renderer.note(
        context.env[mcpHttpMarker(app.envPrefix)] === undefined
          ? `login code for a new browser app: ${code} (until ${expires.toTimeString().slice(0, 5)}; a new one after each login)`
          : `a new login code for a browser app: \`${app.command} ${context.settings.profile} mcp server status\``,
      ),
    onError: (error) => context.renderer.note(`mcp: ${error.message}`),
  }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE")
      throw new CliError("configuration_error", `port ${http.port} is in use — pass another with --port`)
    throw error
  })
  context.renderer.note(
    `serving on ${listening.url.href} — point your tunnel at it; connectors use ${mcpUrlOf(http.publicUrl).href}`,
  )
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve)
    process.once("SIGTERM", resolve)
  })
  await listening.close()
}
