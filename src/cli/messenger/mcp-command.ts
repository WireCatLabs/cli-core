import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { CliError, resolvePaths, visibleControls } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { installerOf } from "@wirecat/cli-base/update"
import { Command } from "commander"
import { ATTACHMENT_LIMIT_ENV } from "../../attachments/limits.js"
import { type AppIdentity, envName } from "../../ports/app.js"
import { type BaseEnvironment, environmentOf } from "../context.js"
import { grantsAuthority, LOCAL_READ, LOCAL_WRITE, REMOTE_WRITE } from "../effects.js"
import { itemOf, renderAnswer } from "../envelope.js"
import { nextStep } from "../steps.js"
import { type Messenger, messengerContext } from "./context.js"

/** Where the running CLI really lives; a test hands in its own. */
export interface McpEnvironment extends BaseEnvironment {
  mcp?: { scriptPath?: string; execPath?: string }
}

export interface McpFlags {
  permission?: string[]
  http?: boolean
  port?: string
  publicUrl?: string
  revoke?: boolean
}

const DEFAULT_PORT = 8765

/** Where `mcp --http` keeps the hashes of the tokens it issued — per profile, in the state folder. */
export const httpTokenFile = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv): string =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "mcp-http", `${profile}.json`)

const publicUrlOf = (app: AppIdentity, given: string | undefined): URL => {
  const example = `--public-url https://<name>.ts.net`
  if (!given) throw new CliError("configuration_error", `--http needs the tunnel's address: ${example}`)
  let url: URL
  try {
    url = new URL(given)
  } catch {
    throw new CliError("validation_error", `--public-url is not an address: ${example}`)
  }
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)
  if (url.protocol !== "https:" && !local)
    throw new CliError(
      "validation_error",
      `--public-url must be https — the browser apps reach ${app.command} through it`,
    )
  if (url.pathname !== "/" || url.search || url.hash)
    throw new CliError("validation_error", `--public-url is the tunnel's address only, without a path: ${example}`)
  return url
}

const portOf = (given: string | undefined): number => {
  if (given === undefined) return DEFAULT_PORT
  const port = Number(given)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new CliError("validation_error", "--port takes 1–65535")
  return port
}

const withFlags = (command: Command): Command =>
  command.option(
    "--permission <key=level>",
    "make a permission stricter for this server only, like messages.send=deny; it never loosens the profile; repeat for more keys",
    (value: string, previous: string[] = []) => [...previous, value],
  )

export const mcpCommand = (messenger: Messenger): Command => {
  const { app } = messenger
  const command = withFlags(
    annotate(new Command("mcp"), { effects: REMOTE_WRITE, lifetime: "persistent", mcp: false }).description(
      `serve this profile to an agent over MCP, on stdin and stdout — \`claude mcp add ${app.command} -- ${app.command} <profile> mcp\``,
    ),
  )
    .option(
      "--http",
      "serve over HTTP on 127.0.0.1 for ChatGPT and Claude in the browser, behind your tunnel; the profile's permissions decide",
    )
    .option("--port <port>", `the local port for --http (default ${DEFAULT_PORT})`)
    .option("--public-url <url>", "the tunnel's https address the browser apps use, e.g. https://<name>.ts.net")
    .option("--revoke", "forget every login given to a browser app; each must log in again")
  command.action(async function (this: Command) {
    const flags = this.optsWithGlobals<McpFlags>()
    const context = messengerContext(this, messenger)
    if (flags.revoke) {
      const { revokeAll } = await import("../../mcp/http/oauth.js")
      revokeAll(httpTokenFile(app, context.settings.profile, context.env))
      renderAnswer(this, context, itemOf({ revoked: true, profile: context.settings.profile }))
      return
    }
    if (flags.http) {
      const publicUrl = publicUrlOf(app, flags.publicUrl)
      const { serveOverHttpUntilStopped } = await import("../../mcp/server.js")
      await serveOverHttpUntilStopped(
        this,
        context,
        messenger,
        {},
        {
          publicUrl,
          port: portOf(flags.port),
          tokenFile: httpTokenFile(app, context.settings.profile, context.env),
        },
      )
      return
    }
    // Loaded here, not at the top: every other command would otherwise pay for the SDK.
    const { serveOverStdio } = await import("../../mcp/server.js")
    await serveOverStdio(this, context, messenger, {})
  })

  command.addCommand(
    withFlags(
      annotate(new Command("config"), { effects: LOCAL_READ }).description(
        "print the mcpServers entry for Claude Desktop, Cursor and others, with full paths; writes nothing",
      ),
    ).action(async function (this: Command) {
      const flags = this.optsWithGlobals<McpFlags>()
      const context = messengerContext(this, messenger)
      const { settings, env } = context
      const given = environmentOf<McpEnvironment>(this).mcp ?? {}
      const entry = serverEntry(app, {
        profile: settings.profile,
        flags,
        execPath: given.execPath ?? process.execPath,
        scriptPath: given.scriptPath ?? realpathSync(process.argv[1] ?? ""),
        env,
      })
      // Pasted into a file, so a person gets the client's own JSON, indented; a script finds it under `config`.
      renderAnswer(
        this,
        context,
        itemOf({ config: entry.config }, { next: entry.nodeBound ? [nextStep("mcp.config", { args: {} })] : [] }),
        () => JSON.stringify(entry.config, null, 2),
      )
    }),
  )
  command.addCommand(
    withFlags(
      grantsAuthority(annotate(new Command("setup"), { effects: LOCAL_WRITE }))
        .description("add this profile's local MCP server to Codex or Claude Code")
        .argument("<client>", "codex or claude-code")
        .option("--allow-writes", "acknowledge that this profile offers writing tools"),
    ).action(async function (this: Command, client: string) {
      if (client !== "codex" && client !== "claude-code")
        throw new CliError("validation_error", "choose codex or claude-code")
      const context = messengerContext(this, messenger)
      const { settings, env } = context
      const given = environmentOf<McpEnvironment>(this).mcp ?? {}
      const configuration = serverEntry(app, {
        profile: settings.profile,
        flags: this.optsWithGlobals<McpFlags>(),
        execPath: given.execPath ?? process.execPath,
        scriptPath: given.scriptPath ?? realpathSync(process.argv[1] ?? ""),
        env,
      })
      const [name, entry] = Object.entries(configuration.config.mcpServers)[0] ?? []
      if (!name || !entry) throw new CliError("validation_error", "the MCP entry is empty")
      const { installStdioEntry, probeStdio } = await import("@wirecat/cli-base/mcp")
      try {
        const server = entry as Parameters<typeof probeStdio>[0]
        const { potentialWrites } = await probeStdio(server)
        if (potentialWrites.length > 0 && this.opts<{ allowWrites?: boolean }>().allowWrites !== true)
          throw new Error(
            `this profile offers ${potentialWrites.length} tools that may write; review its permissions, then pass --allow-writes to install it`,
          )
        renderAnswer(
          this,
          context,
          itemOf({ ...installStdioEntry(client, name, server), potential_writes: potentialWrites.length }),
        )
      } catch (error) {
        throw new CliError("validation_error", error instanceof Error ? error.message : "MCP setup failed")
      }
    }),
  )
  command.addCommand(
    withFlags(
      annotate(new Command("doctor"), { effects: LOCAL_READ }).description(
        "check this profile's local MCP handshake and tool list",
      ),
    ).action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const { settings, env } = context
      const given = environmentOf<McpEnvironment>(this).mcp ?? {}
      const configuration = serverEntry(app, {
        profile: settings.profile,
        flags: this.optsWithGlobals<McpFlags>(),
        execPath: given.execPath ?? process.execPath,
        scriptPath: given.scriptPath ?? realpathSync(process.argv[1] ?? ""),
        env,
      })
      const entry = Object.values(configuration.config.mcpServers)[0]
      if (!entry) throw new CliError("validation_error", "the MCP entry is empty")
      const { probeStdio } = await import("@wirecat/cli-base/mcp")
      const stderr = stderrTail()
      try {
        const { tools, potentialWrites } = await probeStdio(entry as Parameters<typeof probeStdio>[0], {
          start: stderr.start,
        })
        renderAnswer(
          this,
          context,
          itemOf({
            healthy: true,
            profile: settings.profile,
            tools: tools.length,
            potential_writes: potentialWrites.length,
          }),
        )
      } catch (error) {
        const tail = await stderr.tail()
        throw new CliError(
          "validation_error",
          `${error instanceof Error ? error.message : "MCP doctor failed"}${tail ? ` — its last words on stderr:\n${tail}` : ""}`,
          tail ? { stderr: tail } : undefined,
        )
      }
    }),
  )
  return command
}

const TAIL_LINES = 20
const TAIL_BYTES = 2_000
const TAIL_WAIT_MS = 500

/**
 * The server's own stderr, so a failed start says why rather than only that it exited. Read as it
 * comes, which also keeps a chatty server from blocking on a full pipe. Only the end is kept, with the
 * home folder hidden, terminal control codes made visible, and long digit runs — ids, phone numbers —
 * and long token-like runs masked.
 */
export const stderrTail = () => {
  let kept = ""
  let home: string | undefined
  let ended: Promise<void> = Promise.resolve()
  const start = (file: string, args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams => {
    home = env.HOME ?? env.USERPROFILE
    const child = spawn(file, args, { env, stdio: "pipe" })
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      kept = (kept + chunk).slice(-TAIL_BYTES * 4)
    })
    ended = new Promise((resolve) => {
      child.stderr.once("close", resolve)
      child.once("error", () => resolve())
    })
    return child
  }
  // The exit that fails the probe can arrive before the last stderr chunk, and the last lines say why.
  const tail = async (): Promise<string> => {
    await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, TAIL_WAIT_MS).unref())])
    return redactTail(kept, home)
  }
  return { start, tail }
}

export const redactTail = (text: string, home: string | undefined): string => {
  let out = visibleControls(text)
  if (home) out = out.split(home).join("~")
  out = out.replace(/[A-Za-z0-9_\-+=]{32,}/g, "[hidden]").replace(/\+?\d[\d ]{5,}\d/g, "[number]")
  const lines = out.split("\n").filter((line) => line.trim() !== "")
  return lines.slice(-TAIL_LINES).join("\n").slice(-TAIL_BYTES)
}

const VERSION_MANAGER = /[\\/](\.nvm|nvm|\.fnm|fnm|fnm_multishells|\.volta|volta|\.asdf|mise)[\\/]/i

/**
 * `node` and the script by full path, on every platform: a client started from the desktop does
 * not see the PATH a terminal has, and on Windows the command is a `.cmd` file that a client which
 * starts programs without a shell cannot run. The directories are copied when set — they choose the
 * keyring entry and the store, so a server without them would answer "no session" or search another
 * store. So is `XDG_RUNTIME_DIR`: the keyring is reached through it, and an MCP client that starts
 * servers with a trimmed environment leaves it out (measured 2026-09-28). Credentials are never copied.
 */
export const serverEntry = (
  app: AppIdentity,
  {
    profile,
    flags = {},
    execPath,
    scriptPath,
    env,
  }: { profile: string; flags?: McpFlags; execPath: string; scriptPath: string; env: NodeJS.ProcessEnv },
): { config: { mcpServers: Record<string, object> }; nodeBound: boolean } => {
  if (installerOf(scriptPath) === "npx") {
    throw new CliError(
      "validation_error",
      `this ${app.command} runs from npx's cache, which gets cleared, and the path would stop working — ` +
        `install it globally, then run \`${app.command} mcp config\` again`,
    )
  }
  const names = [
    ...["CONFIG_DIR", "STATE_DIR", "CACHE_DIR"].map((name) => envName(app, name)),
    "MESSAGING_STORE",
    ...ATTACHMENT_LIMIT_ENV,
    "XDG_RUNTIME_DIR",
  ]
  const directories = Object.fromEntries(names.flatMap((name) => (env[name] ? [[name, env[name]]] : [])))
  const server = {
    type: "stdio",
    command: execPath,
    args: [scriptPath, profile, "mcp", ...(flags.permission ?? []).flatMap((entry) => ["--permission", entry])],
    ...(Object.keys(directories).length > 0 ? { env: directories } : {}),
  }
  return {
    config: { mcpServers: { [`${app.command}-${profile}`]: server } },
    /** The path belongs to one Node version of a version manager; switching Node breaks the entry. */
    nodeBound: VERSION_MANAGER.test(execPath),
  }
}
