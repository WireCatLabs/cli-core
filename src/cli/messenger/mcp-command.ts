import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import type { Readable, Writable } from "node:stream"
import { CliError, resolvePaths, visibleControls } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { installerOf } from "@wirecat/cli-base/update"
import { Command } from "commander"
import { ATTACHMENT_LIMIT_ENV } from "../../attachments/limits.js"
import type { ServerSystem } from "../../background/system.js"
import { mcpUrlOf, portOf, publicUrlOf } from "../../http/public-url.js"
import { httpLockFile } from "../../mcp/http/state.js"
import { type AppIdentity, envName } from "../../ports/app.js"
import { type BaseEnvironment, environmentOf } from "../context.js"
import { grantsAuthority, LOCAL_READ, LOCAL_WRITE, REMOTE_WRITE } from "../effects.js"
import { itemOf, renderAnswer } from "../envelope.js"
import { MCP_HTTP_DEFAULT_PORT, mcpServerCommand } from "../mcp-server-command.js"
import { rootOf } from "../profile.js"
import { namedProfile } from "../settings.js"
import { nextStep } from "../steps.js"
import { recalledAccount } from "./accounts.js"
import { type Messenger, type MessengerContext, messengerContext } from "./context.js"

/** Where the running CLI really lives; a test hands in its own. */
export interface McpEnvironment extends BaseEnvironment {
  mcp?: { scriptPath?: string; execPath?: string }
  system?: ServerSystem
}

export interface McpFlags {
  permission?: string[]
  http?: boolean
  port?: string
  publicUrl?: string
  revoke?: boolean
}

const DEFAULT_PORT = MCP_HTTP_DEFAULT_PORT

/** The token file of `<tool> mcp serve --http` for every profile: no profile name can start with `_`. */
export const ALL_PROFILES = "_all"

/** Where `mcp serve --http` keeps the hashes of the tokens it issued — per profile, in the state folder. */
export const httpTokenFile = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv): string =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "mcp-http", `${profile}.json`)

const withFlags = (command: Command): Command =>
  command.option(
    "--permission <key=level>",
    "make a permission stricter for this server only, like messages.send=deny; it never loosens the profile; repeat for more keys",
    (value: string, previous: string[] = []) => [...previous, value],
  )

export const mcpCommand = (messenger: Messenger): Command => {
  const { app } = messenger
  const command = annotate(new Command("mcp"), { effects: LOCAL_READ, mcp: false })
    .summary("serve this profile's commands to an AI agent, and set that up")
    .description(
      `serve this profile to an agent over MCP and set it up — \`claude mcp add ${app.command} -- ${app.command} <profile> mcp serve\``,
    )
  command.addCommand(
    withFlags(
      annotate(new Command("serve"), {
        effects: REMOTE_WRITE,
        lifetime: "persistent",
        mcp: false,
        examples: [
          `${app.command} personal mcp serve`,
          `${app.command} personal mcp serve --http --public-url https://laptop.example.ts.net`,
        ],
      })
        .summary("serve this profile's commands to an AI agent")
        .description(
          `serve this profile to an agent over MCP, on stdin and stdout — \`claude mcp add ${app.command} -- ${app.command} <profile> mcp serve\`; with no profile, \`${app.command} mcp serve\` serves every profile and each tool asks which`,
        ),
    )
      .option(
        "--http",
        "serve over HTTP on 127.0.0.1 for ChatGPT and Claude in the browser, behind your tunnel; the profile's permissions decide",
      )
      .option("--port <port>", `the local port for --http (default ${DEFAULT_PORT})`)
      .option(
        "--public-url <url>",
        "the tunnel's https address the browser apps use, e.g. https://<name>.ts.net or https://<name>.ts.net/tg",
      )
      .option("--revoke", "forget every login given to a browser app; each must log in again")
      .action(async function (this: Command) {
        const flags = this.optsWithGlobals<McpFlags>()
        const context = messengerContext(this, messenger, { needsProfile: false })
        const profile = namedProfile(context.settings)
        if (flags.revoke) return revoke(this, context, app, profile)
        if (profile === undefined) return serveEveryProfile(this, context, messenger, flags)
        if (flags.http) {
          const publicUrl = publicUrlOf(flags.publicUrl, {
            missing: "--http",
            reaches: `the browser apps reach ${app.command}`,
            path: true,
          })
          const { serveOverHttpUntilStopped } = await import("../../mcp/server.js")
          const tokenFile = httpTokenFile(app, profile, context.env)
          await serveOverHttpUntilStopped(
            this,
            context,
            messenger,
            {},
            {
              publicUrl,
              port: portOf(flags.port, DEFAULT_PORT),
              tokenFile,
              lockFile: httpLockFile(tokenFile),
              version: app.version,
            },
          )
          return
        }
        // Loaded here, not at the top: every other command would otherwise pay for the SDK.
        const { serveOverStdio } = await import("../../mcp/server.js")
        await serveOverStdio(this, context, messenger, {})
      }),
  )

  command.addCommand(
    mcpServerCommand({
      example: `${app.command} personal`,
      permission: true,
      target: (self) => {
        const { settings, env } = messengerContext(self, messenger, { needsProfile: false })
        if (namedProfile(settings) === undefined)
          return {
            invocation: app.command,
            envPrefix: app.envPrefix,
            env,
            tokenFile: httpTokenFile(app, ALL_PROFILES, env),
            argv: ["mcp", "serve", "--http"],
            version: app.version,
          }
        return {
          invocation: `${app.command} ${settings.profile}`,
          profile: settings.profile,
          envPrefix: app.envPrefix,
          env,
          tokenFile: httpTokenFile(app, settings.profile, env),
          argv: ["mcp", "serve", "--http"],
          childEnv: { [`${app.envPrefix}_PROFILE`]: settings.profile },
          version: app.version,
        }
      },
      answer: (self, item, lines) =>
        renderAnswer(self, messengerContext(self, messenger, { needsProfile: false }), itemOf(item), () =>
          lines.join("\n"),
        ),
      system: (self) => environmentOf<McpEnvironment>(self).system,
    }),
  )
  command.addCommand(
    withFlags(
      annotate(new Command("config"), {
        effects: LOCAL_READ,
        examples: [`${app.command} personal mcp config`],
      })
        .summary("print the local MCP configuration, of this profile or of every profile")
        .description(
          "print the mcpServers entry for Claude Desktop, Cursor and others, with full paths; writes nothing",
        ),
    ).action(async function (this: Command) {
      const flags = this.optsWithGlobals<McpFlags>()
      const context = messengerContext(this, messenger, { needsProfile: false })
      const { settings, env } = context
      const given = environmentOf<McpEnvironment>(this).mcp ?? {}
      const named = namedProfile(settings)
      const entry = serverEntry(app, {
        ...(named === undefined ? {} : { profile: named }),
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
      grantsAuthority(
        annotate(new Command("add"), {
          effects: LOCAL_WRITE,
          examples: [`${app.command} personal mcp add codex --allow-writes`],
        }),
      )
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
            `this profile offers ${potentialWrites.length} ${potentialWrites.length === 1 ? "tool" : "tools"} that may write; review its permissions, then pass --allow-writes to install it`,
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
      annotate(new Command("check"), {
        effects: LOCAL_READ,
        examples: [`${app.command} personal mcp check`],
      }).description("check this profile's local MCP handshake and tool list"),
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
        const account = messenger.accountOf?.(this) ?? recalledAccount(app, messenger.provider, settings.profile, env)
        if (!account) {
          const setup = rootOf(this).commands.some((one) => one.name() === "setup")
            ? ` — log in with \`${app.command} ${settings.profile} setup\``
            : ""
          context.renderer.warn(
            `the server starts, but profile ${settings.profile} has no account on this computer yet, so its ` +
              `tools will fail${setup}`,
          )
        }
        renderAnswer(
          this,
          context,
          itemOf({
            healthy: account !== undefined,
            profile: settings.profile,
            signed_in: account !== undefined,
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

/** `mcp serve --revoke`: kept apart so it can become its own leaf without touching the server. */
const revoke = async (self: Command, context: MessengerContext, app: AppIdentity, profile: string | undefined) => {
  const { revokeAll } = await import("../../mcp/http/oauth.js")
  revokeAll(httpTokenFile(app, profile ?? ALL_PROFILES, context.env))
  renderAnswer(self, context, itemOf({ revoked: true, profile: profile ?? null }))
}

/**
 * `<tool> mcp serve` with no profile: every profile on this computer, each call in that profile's own
 * `<tool> <profile> mcp serve`
 * (`src/mcp/all-profiles.ts`). Nothing picks a profile: each tool takes one, and the agent is told to ask.
 */
const serveEveryProfile = async (self: Command, context: MessengerContext, messenger: Messenger, flags: McpFlags) => {
  const { app } = messenger
  const { env } = context
  const tokenFile = httpTokenFile(app, ALL_PROFILES, env)
  const profiles = () =>
    messenger.resolveSettings(self.optsWithGlobals(), { env, needsProfile: false, readOnly: true }).profilesHere
  if (profiles().length === 0)
    throw new CliError(
      "configuration_error",
      `no ${app.command} profile on this computer yet — set one up, then run \`${app.command} mcp serve\` again`,
    )
  const given = environmentOf<McpEnvironment>(self).mcp ?? {}
  const execPath = given.execPath ?? process.execPath
  const scriptPath = given.scriptPath ?? realpathSync(process.argv[1] ?? "")
  const tightened = (flags.permission ?? []).flatMap((entry) => ["--permission", entry])
  const { instructions } = await import("../../mcp/instructions.js")
  const options = {
    command: app.command,
    version: app.version,
    name: messenger.name ?? app.command,
    profiles,
    child: (profile: string) => ({ command: execPath, args: [scriptPath, profile, "mcp", "serve", ...tightened], env }),
    instructions: instructions({
      command: app.command,
      name: messenger.name ?? app.command,
      profile: profiles(),
      writes: [],
    }),
    note: (line: string) => context.renderer.note(line),
  }
  if (flags.http) {
    const publicUrl = publicUrlOf(flags.publicUrl, {
      missing: "--http",
      reaches: `the browser apps reach ${app.command}`,
      path: true,
    })
    const { serveAllProfilesOverHttp } = await import("../../mcp/all-profiles.js")
    const { mcpHttpMarker } = await import("../../mcp/http/state.js")
    const port = portOf(flags.port, DEFAULT_PORT)
    const listening = await serveAllProfilesOverHttp(options, {
      publicUrl,
      port,
      tokenFile,
      lockFile: httpLockFile(tokenFile),
      version: app.version,
      onCode: (code, expires) =>
        context.renderer.note(
          env[mcpHttpMarker(app.envPrefix)] === undefined
            ? `login code for a new browser app: ${code} (until ${expires.toTimeString().slice(0, 5)}; a new one after each login)`
            : `a new login code for a browser app: \`${app.command} mcp server status\``,
        ),
    }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE")
        throw new CliError("configuration_error", `port ${port} is in use — pass another with --port`)
      throw error
    })
    context.renderer.note(
      `serving every profile on ${listening.url.href} — point your tunnel at it; connectors use ${mcpUrlOf(publicUrl).href}`,
    )
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve)
      process.once("SIGTERM", resolve)
    })
    await listening.close()
    return
  }
  const { serveAllProfilesOverStdio } = await import("../../mcp/all-profiles.js")
  const { stdin, stdout, signal } = environmentOf(self)
  await serveAllProfilesOverStdio(options, {
    ...(stdin ? { stdin: stdin as Readable } : {}),
    ...(stdout ? { stdout: stdout as Writable } : {}),
    ...(signal ? { signal } : {}),
  })
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
  }: {
    /** Left out, the entry is `<tool> mcp serve`, the server of every profile. */
    profile?: string
    flags?: McpFlags
    execPath: string
    scriptPath: string
    env: NodeJS.ProcessEnv
  },
): { config: { mcpServers: Record<string, object> }; nodeBound: boolean } => {
  if (installerOf(scriptPath) === "npx") {
    throw new CliError(
      "validation_error",
      `this ${app.command} runs from npx's cache, which gets cleared, and the path would stop working — ` +
        `install it globally, then run \`${app.command} ${profile === undefined ? "" : `${profile} `}mcp config\` again`,
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
    args: [
      scriptPath,
      ...(profile === undefined ? [] : [profile]),
      "mcp",
      "serve",
      ...(flags.permission ?? []).flatMap((entry) => ["--permission", entry]),
    ],
    ...(Object.keys(directories).length > 0 ? { env: directories } : {}),
  }
  return {
    config: { mcpServers: { [profile === undefined ? app.command : `${app.command}-${profile}`]: server } },
    /** The path belongs to one Node version of a version manager; switching Node breaks the entry. */
    nodeBound: VERSION_MANAGER.test(execPath),
  }
}
