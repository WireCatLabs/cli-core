import { randomUUID } from "node:crypto"
import type { Readable, Writable } from "node:stream"
import { type CallToolResult, McpServer } from "@modelcontextprotocol/server"
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio"
import { CliError, mcpErrorResult } from "@wirecat/cli-base"
import { describeProgram } from "@wirecat/cli-base/commands"
import { skillResource } from "@wirecat/cli-base/skill"
import type { ErrorObject } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { findCommand } from "../cli/command-contract.js"
import { environmentOf } from "../cli/context.js"
import { refuseWriteBeforeConnecting } from "../cli/early-refusal.js"
import { changesAuthorityAt, fetchesOnlyAt, judgedTargets } from "../cli/effects.js"
import { itemOf } from "../cli/envelope.js"
import { DEFAULT_OUTPUT_BYTES } from "../cli/execution.js"
import { recalledAccount } from "../cli/messenger/accounts.js"
import { wholeList } from "../cli/messenger/chat-answers.js"
import { connectedFor, type Messenger, type MessengerContext } from "../cli/messenger/context.js"
import { lackedNeed } from "../cli/messenger/lacks.js"
import { syncsFirst } from "../cli/messenger/search-sync-options.js"
import { stdinFieldOf } from "../cli/stdin-field.js"
import { rootOf } from "../cli/steps.js"
import { warmEmbedders } from "../embeddings/embed.js"
import { mcpUrlOf } from "../http/public-url.js"
import { readOnlyLockOf } from "../ports/app.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { RunCaller } from "../runs/run-context.js"
import { guardFor } from "../sends/guard.js"
import { levelFor, type PermissionKey, readKeysForCommand } from "../sends/permissions.js"
import { openStore } from "../store/store.js"
import { type AgentAnswer, type AgentProgram, type AgentTool, runCommandForAgent, toolsFromCommands } from "./agent.js"
import { agentLog } from "./agent-log.js"
import { type CallerSource, callerOf, callingAgent, withCaller } from "./caller.js"
import type { HttpOptions } from "./http/serve.js"
import { mcpHttpMarker } from "./http/state.js"
import { instructions } from "./instructions.js"
import { registerPrompts } from "./prompts.js"
import { registerResources } from "./resources.js"
import { harmless, MessengerSession, type SessionOptions } from "./session.js"
import { answeredWire } from "./stdio-wire.js"
import { type McpCommand, normal, outputOf, registerCommands, surfaceCommands } from "./surface.js"
import { agentJson } from "./text.js"
import {
  answered,
  commandOf,
  failed,
  outcomeOf,
  READ,
  type Registration,
  type ToolCall,
  tierOf,
  tool,
  toolKey,
  WRITE,
} from "./tool.js"
import { pictureTools } from "./tools.js"

export type ServerOptions = SessionOptions & { spawnJob?: import("../services/backfill-jobs.js").SpawnJob }

type Invocation = Parameters<Messenger["connect"]>[0]

/** What `run()` sets for each run itself; everything else a test or the CLI handed the server reaches its commands. */
export const PER_RUN = new Set([
  "streams",
  "stdin",
  "stdout",
  "stderr",
  "tty",
  "signal",
  "commandSignal",
  "trackCloseable",
  "exit",
  "runCommand",
  "discoveryAvailability",
  "app",
  "relayed",
  "agent",
  "answer",
  "untilStopped",
  "endUntilStopped",
  "handled",
  "mcp",
])

const SYNC_FIELDS = ["sync_first", "sync_time", "max_chats", "max_messages"]

/** A command an agent may run, as the tool name `instructions` and the audit tier read it: `chats_mark_read`. */
const keyOfCommand = (command: string) => command.replace(/[ -]/g, "_")

/** A command's `--json` answer is already an envelope; a bare list or value is wrapped as one. */
export const envelope = (command: string, value: unknown): object =>
  Array.isArray(value)
    ? wholeList(command, value)
    : value !== null && typeof value === "object" && ("item" in value || "items" in value)
      ? value
      : itemOf(value !== null && typeof value === "object" ? value : { value })

/**
 * A factory of servers over one session. `serveStdio` may build a probe instance and throw it away
 * before settling on the protocol era, so each call is a fresh server — and all of them share the
 * one connection, which is the thing that must not be opened twice.
 *
 * Every tool is a command of this CLI (`toolsFromCommands`), run in this process through the CLI's own `run`
 * (`runCommandForAgent`) on the session's connection. The few answers a command cannot give — a picture handed to
 * the model — stay definitions of their own (`pictureTools`).
 */
export const createServer = (
  command: Invocation,
  context: MessengerContext,
  messenger: Messenger,
  sessionOptions: ServerOptions,
) => {
  const { app, provider } = messenger
  const name = messenger.name ?? app.command
  const { settings } = context
  const root = rootOf(command)
  const environment = environmentOf(command)
  if (!environment.runCommand) throw new Error("the MCP server runs inside run(), which hands it the program")
  const program: AgentProgram = { run: environment.runCommand, commands: describeProgram(root) }
  const overrides = command.optsWithGlobals<{ permission?: string[] }>().permission ?? []
  const refreshPermissions = () => {
    const current = messenger.resolveSettings(command.optsWithGlobals(), { env: context.env })
    settings.permissions = current.permissions
    settings.permissionSources = current.permissionSources
  }
  const levelOf = (key: string | null | undefined) => (key ? levelFor(settings.permissions, key).level : "allow")
  const keyOf = (path: readonly string[]): PermissionKey | null | undefined => {
    if (!messenger.permissionKey) return undefined
    try {
      return messenger.permissionKey(findCommand(root, path))
    } catch {
      return undefined
    }
  }
  const authority = changesAuthorityAt(root)
  const stdin = (path: readonly string[]) => {
    try {
      return stdinFieldOf(findCommand(root, path))
    } catch {
      return undefined
    }
  }
  const syncAllowed = (path: readonly string[]) =>
    syncsFirst(messenger) &&
    levelOf("messages.sync-first") === "allow" &&
    (path[0] !== "stats" || levelOf(`${path.join(".")}.sync-first`) === "allow")
  // Discovery stays complete while availability follows changes to the profile.
  const generated = toolsFromCommands(program.commands, {
    includeUnavailable: true,
    exclude: [["bot"]],
    levels: settings.permissions,
    currentLevels: () => {
      refreshPermissions()
      return settings.permissions
    },
    readOnly: readOnlyLockOf(app, context.env) !== undefined,
    keyOf,
    authority,
    fetchOnly: fetchesOnlyAt(root),
    offline: true,
    stdin,
  }).map((one) =>
    "sync_first" in one.input.entries && !syncAllowed(one.path)
      ? {
          ...one,
          input: v.object(
            Object.fromEntries(Object.entries(one.input.entries).filter(([field]) => !SYNC_FIELDS.includes(field))),
          ),
        }
      : one,
  )
  const catalogue = toolsFromCommands(program.commands, { exclude: [["bot"]] })
  const mounted = new Set(catalogue.map((one) => one.command))
  const withheld = (asked: string) => {
    const one = catalogue.find((tool) => normal(tool.command) === asked)
    if (one)
      refuseWriteBeforeConnecting(findCommand(root, one.path), {
        app,
        env: context.env,
        dryRun: false,
        resolve: messenger.resolveSettings,
      })
  }
  const pictures = Object.fromEntries(
    Object.entries(pictureTools(messenger)).filter(([key, one]) => {
      const path = commandOf(key, one).split(" ")
      if (!one.agentOnly && (!mounted.has(path.join(" ")) || lackedNeed(messenger, path.join(" ")))) return false
      return true
    }),
  )
  const pictured = new Set(Object.entries(pictures).map(([key, one]) => commandOf(key, one)))
  // A command whose one adapter method the messenger lacks only refuses: an agent is not handed it.
  const commands = generated.filter((one) => !pictured.has(one.command) && !lackedNeed(messenger, one.command))
  const writes = commands
    .filter((one) => one.writes && one.availability?.().available !== false)
    .map((one) => one.command)
  // No one is at a terminal to answer the guard's question: over MCP a write at level `ask` goes ahead.
  const goAhead = async () => {}
  const guard =
    messenger.guard?.(command, settings, context.renderer.warn, goAhead) ??
    guardFor(app, settings, context.renderer.warn, context.env, goAhead)
  const session = new MessengerSession(
    async (events) => connectedFor(command, messenger, context, { events }),
    (run, body) => context.run(body, { name: run }),
    sessionOptions,
  )

  const embedders = warmEmbedders()
  const status = tool({
    title: "This server's profile and login",
    description:
      "Which profile this server speaks for, which account it last logged in as here, and which writing commands " +
      "are on. Never connects, so it answers when the login is what is broken.",
    input: v.strictObject({}),
    annotations: { ...READ, idempotentHint: true },
    local: async () =>
      itemOf({
        profile: settings.profile,
        account: recalledAccount(app, provider, settings.profile, context.env)?.account ?? null,
        writes,
        permissions: settings.permissions,
        ...(messenger.diagnose ? { [messenger.provider]: await messenger.diagnose(command, context) } : {}),
      }),
  })
  const skill = messenger.skill ? skillResource(app, messenger.skill) : undefined
  const log = agentLog(() => openStore({ env: context.env, command: app.command, version: app.version }))
  const audit = async (call: ToolCall, caller: RunCaller | undefined) => {
    if (!recalledAccount(app, provider, settings.profile, context.env)) return
    await log.record({ actor: { bot: callingAgent(`${app.command}-mcp`, caller) }, ...call })
  }
  const targets = judgedTargets(root)
  const passed = Object.fromEntries(Object.entries(environment).filter(([key]) => !PER_RUN.has(key)))
  const agentEnvironment = {
    ...passed,
    embedders,
    ...(sessionOptions.spawnJob ? { spawnJob: sessionOptions.spawnJob } : {}),
  }

  /**
   * One command at a time, on the session's connection, opened only if the command asks for it. A failure that may
   * have been the connection's drops it, as the session does for its own calls.
   */
  const invoke = (
    one: AgentTool,
    input: Record<string, unknown>,
    env: NodeJS.ProcessEnv,
    caller: RunCaller,
  ): Promise<AgentAnswer> =>
    new Promise<AgentAnswer>((resolve) => {
      let finish: ((drop: boolean) => void) | undefined
      let held: Promise<unknown> | undefined
      const connection = () =>
        new Promise<MessengerAdapter>((lend, refuse) => {
          held = session.use(
            `mcp ${one.command}`,
            (adapter, release) =>
              new Promise<void>((done) => {
                finish = (drop) => void (drop ? release().finally(done) : done())
                lend(adapter)
              }),
          )
          held.catch(refuse)
        })
      void runCommandForAgent(program, one.path, input, {
        profile: settings.profile,
        readOnly: readOnlyLockOf(app, env) !== undefined,
        env,
        levels: () => {
          refreshPermissions()
          return settings.permissions
        },
        overrides,
        keyOf,
        authority,
        stdin,
        connection,
        environment: agentEnvironment,
        caller,
      }).then(async (answer) => {
        finish?.("error" in answer && !harmless(answer.error.error.code))
        await held?.catch(() => undefined)
        resolve(answer)
      })
    })
  let queue: Promise<unknown> = Promise.resolve()
  const queued = (
    one: AgentTool,
    input: Record<string, unknown>,
    env: NodeJS.ProcessEnv,
    caller: RunCaller,
  ): Promise<AgentAnswer> => {
    const next = queue.then(() => invoke(one, input, env, caller))
    queue = next.catch(() => undefined)
    return next
  }

  const asCommand = (one: AgentTool, source: CallerSource): McpCommand => ({
    title: one.title,
    description: one.description,
    writes: one.writes,
    availability: one.availability,
    input: one.input,
    ...(one.output ? { output: outputOf(one.output) } : {}),
    run: async (args, ctx) => {
      const startedAt = Date.now()
      // The caller's trace reaches the run, its send journal lines and its record, as `TRACEPARENT` does.
      const traceparent = ctx?.mcpReq?._meta?.traceparent
      const env = typeof traceparent === "string" ? { ...context.env, TRACEPARENT: traceparent } : context.env
      const caller = callerOf(ctx, keyOfCommand(one.command), source)
      // The connection the session opens for this call is recorded under the same caller.
      const answer = await withCaller(caller, () => queued(one, args, env, caller))
      const result =
        "error" in answer
          ? (mcpErrorResult(JSON.parse(agentJson(answer.error)) as ErrorObject) as CallToolResult)
          : (() => {
              try {
                return answered(envelope(one.command, answer.result), DEFAULT_OUTPUT_BYTES, targets)
              } catch (error) {
                return failed(error, app.errors)
              }
            })()
      // The audit row must not cost the agent its answer: a store that cannot be written is not this call's failure.
      await audit(
        {
          tool: keyOfCommand(one.command),
          tier: tierOf(keyOfCommand(one.command), { annotations: one.writes ? WRITE : READ }, messenger),
          ...outcomeOf(result),
          startedAt,
          finishedAt: Date.now(),
        },
        caller,
      ).catch(() => undefined)
      return result
    },
  })

  const build = (): McpServer => {
    // Built once for a stdio connection; over HTTP the session or the OAuth client identifies the caller instead.
    const callers: CallerSource = {
      env: context.env,
      client: () => server.server.getClientVersion(),
      connectionId: randomUUID(),
    }
    const server = new McpServer(
      { name: app.command, version: app.version },
      {
        instructions: instructions({
          command: app.command,
          name,
          profile: settings.profile,
          writes: [
            ...writes,
            ...Object.keys(pictures).filter((key) => pictures[key]?.annotations.readOnlyHint !== true),
          ].map(keyOfCommand),
          ...(skill ? { skill: skill.instruction } : {}),
        }),
      },
    )
    const registration: Registration = {
      command: app.command,
      messenger,
      session,
      withStore: context.withStore,
      targets,
      log: audit,
      around: (key, definition, work) => {
        refreshPermissions()
        const level = levelOf(toolKey(key, definition))
        if (level === "deny" || (definition.annotations.readOnlyHint !== true && level === "readonly"))
          throw new CliError("permission_error", "the current profile does not allow this command", {
            permission: toolKey(key, definition),
          })
        return work()
      },
      defaults: {
        spawnJob: sessionOptions.spawnJob,
        limit: settings.limit,
        get syncAllowed() {
          return syncsFirst(messenger) && levelOf("messages.sync-first") === "allow"
        },
        guard,
        settings,
        env: context.env,
        ...(context.keyring ? { keyring: context.keyring } : {}),
        embedders,
        history: settings.record,
      },
      callers,
    }
    registerCommands(
      server,
      app.command,
      {
        ...Object.fromEntries(commands.map((one) => [one.command, asCommand(one, callers)])),
        ...Object.fromEntries(
          Object.entries(surfaceCommands({ ...pictures, status }, registration)).map(([name, one]) => [
            name,
            {
              ...one,
              availability: () => {
                refreshPermissions()
                const picture = Object.entries(pictures).find(
                  ([key, definition]) => commandOf(key, definition) === name,
                )
                if (!picture) return { available: true }
                const key = toolKey(picture[0], picture[1])
                const level = levelOf(key)
                const denied = readKeysForCommand(name.split(" ")).find((read) => levelOf(read) === "deny")
                const permission = level === "deny" || (one.writes && level === "readonly") ? key : denied
                return permission
                  ? { available: false, reason: `the profile does not allow ${permission}`, permission }
                  : { available: true }
              },
            },
          ]),
        ),
      },
      app.errors,
      withheld,
      app.messenger,
    )
    // The prompts and resources show messages, so a profile that may not read them gets neither.
    if (levelOf("messages") !== "deny") registerPrompts(server, { command: app.command, name })
    if (levelOf("messages") !== "deny")
      registerResources(server, session, {
        command: app.command,
        name,
        limit: settings.limit,
        recorded: () => recalledAccount(app, provider, settings.profile, context.env) !== undefined,
        withStore: context.withStore,
        messenger,
        guard,
        assertRead: (key) => {
          refreshPermissions()
          if (levelOf(key) === "deny")
            throw new CliError("permission_error", "the current profile does not allow this resource", {
              permission: key,
            })
        },
      })
    if (skill) {
      const { uri, name: resource, title, description, mimeType, read } = skill
      server.registerResource(resource, uri, { title, description, mimeType }, read)
    }
    return server
  }
  return { session, embedders, build, log, offered: [...commands.map((one) => one.command), ...pictured] }
}

/**
 * Serves until the client closes stdin or the process is told to stop, then closes the connection.
 * **Returning is what lets the process exit**: the transport lets go of stdin, and the session is
 * the only other thing that could hold it open.
 */
export const serveOverStdio = async (
  command: Invocation,
  context: MessengerContext,
  messenger: Messenger,
  options: ServerOptions,
): Promise<void> => {
  const { session, embedders, build, log } = createServer(command, context, messenger, options)
  // Relayed by serve, or given by a test's `run()`, the session's bytes are not this process's stdio.
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

  try {
    // A one-shot pipe writes its calls and closes stdin: what it asked is still answered (FIND-1514).
    if (ended === "input") await wire.answered()
    wire.release()
    await handle.close()
    await session.close()
  } finally {
    await log.close()
    await embedders.close()
  }
}

/** The same server over HTTP, until Ctrl-C (CLI-58). */
export const serveOverHttpUntilStopped = async (
  command: Invocation,
  context: MessengerContext,
  messenger: Messenger,
  options: ServerOptions,
  http: Omit<HttpOptions, "onCode" | "onError" | "appName">,
): Promise<void> => {
  const { session, embedders, build, log } = createServer(command, context, messenger, options)
  const { serveOverHttp } = await import("./http/serve.js")
  const appName = messenger.app.command
  const appEnvPrefix = messenger.app.envPrefix
  const listening = await serveOverHttp(build, {
    ...http,
    appName,
    // In the background its log is a file; the code goes only to the lock that `mcp server status` reads.
    onCode: (code, expires) =>
      context.renderer.note(
        context.env[mcpHttpMarker(appEnvPrefix)] === undefined
          ? `login code for a new browser app: ${code} (until ${expires.toTimeString().slice(0, 5)}; a new one after each login)`
          : `a new login code for a browser app: \`${appName} ${context.settings.profile} mcp server status\``,
      ),
    onError: (error) => context.renderer.note(`mcp: ${error.message}`),
  }).catch(async (error: unknown) => {
    await session.close()
    await embedders.close()
    await log.close()
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

  try {
    await listening.close()
    await session.close()
  } finally {
    await log.close()
    await embedders.close()
  }
}
