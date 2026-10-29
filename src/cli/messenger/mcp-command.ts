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
import type { HttpOptions } from "../../mcp/http/serve.js"
import { httpLockFile } from "../../mcp/http/state.js"
import { type AppIdentity, envName } from "../../ports/app.js"
import { type BaseContext, type BaseEnvironment, environmentOf } from "../context.js"
import { grantsAuthority, LOCAL_READ, LOCAL_WRITE, REMOTE_WRITE } from "../effects.js"
import { itemOf, renderAnswer } from "../envelope.js"
import { MCP_HTTP_DEFAULT_PORT, mcpServerCommand } from "../mcp-server-command.js"
import { rootOf } from "../profile.js"
import { type GlobalFlags, NoProfileHere, namedProfile, type ResolveOptions, type Settings } from "../settings.js"
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
  profiles?: string
}

const DEFAULT_PORT = MCP_HTTP_DEFAULT_PORT

/** The token file of `<tool> mcp serve --http --profiles all`: no profile name can start with `_`. */
export const ALL_PROFILES = "_all"

/** `--profiles all`; a profile named `all` is served alone, as `<tool> all mcp serve`. */
export const EVERY_PROFILE = "all"

/** The profiles `--profiles` names: `all`, read again on each session, or a fixed list. */
export interface ProfileSet {
  /** What `--profiles` takes to name this set again: `all`, or the names sorted, comma-separated. */
  option: string
  profiles: () => string[]
  /** The token file's name: a list's login never opens the server of other profiles. */
  key: string
}

/**
 * The profile or profiles an MCP server is for, always named (NEED-1881, WC-MCP-9): a leading profile, or
 * `--profiles` with a list or `all`. Neither, or both, is refused with the profiles on this computer. `--profiles`
 * takes the place of `<PREFIX>_PROFILE`; under `<PREFIX>_PROFILE_LOCK` it may name the locked profile only
 * (WC-ACCT-5).
 */
export const servedProfiles = (
  self: Command,
  messenger: Pick<Messenger, "app" | "resolveSettings">,
  { settings, env }: { settings: Pick<Settings, "profile" | "sources" | "profilesHere">; env: NodeJS.ProcessEnv },
  given: string | undefined,
  words: string,
): { profile: string } | { set: ProfileSet } => {
  const { app } = messenger
  const here = settings.profilesHere
  const listed = `profiles here: ${here.length > 0 ? here.join(", ") : "none"}`
  const named = namedProfile(settings)
  if (given === undefined && named !== undefined) return { profile: named }
  if (given !== undefined && settings.sources.profile === "first word")
    throw new CliError(
      "validation_error",
      `name one profile or --profiles, not both: \`${app.command} ${named} ${words}\` or \`${app.command} ${words} ` +
        `--profiles ${given}\``,
      { profiles: here },
    )
  if (given === undefined) {
    if (here.length === 0) throw new NoProfileHere(app)
    throw new CliError(
      "validation_error",
      `name the profiles to serve: \`${app.command} <profile> ${words}\`, or \`${app.command} ${words} --profiles ` +
        `<a,b>\` or \`--profiles all\` — ${listed}`,
      { profiles: here },
    )
  }
  const names = [...new Set(given.split(",").map((one) => one.trim()))].filter(Boolean).sort()
  const lock = env[envName(app, "PROFILE_LOCK")]?.trim()
  if (lock && names.some((one) => one !== lock))
    throw new CliError(
      "permission_error",
      `this process is locked to profile ${lock} (${envName(app, "PROFILE_LOCK")}) — --profiles may name only ${lock}`,
    )
  if (lock) return { set: { option: lock, profiles: () => [lock], key: `_${lock}` } }
  if (names.length === 1 && names[0] === EVERY_PROFILE) {
    const every = () =>
      messenger.resolveSettings(self.optsWithGlobals(), { env, needsProfile: false, readOnly: true }).profilesHere
    return { set: { option: EVERY_PROFILE, profiles: every, key: ALL_PROFILES } }
  }
  if (names.length === 0 || names.includes(EVERY_PROFILE))
    throw new CliError(
      "validation_error",
      `--profiles takes profile names, comma-separated, or \`all\` alone for every profile — a profile named all ` +
        `is served as \`${app.command} all ${words}\`; ${listed}`,
      { profiles: here },
    )
  const unknown = names.filter((one) => !here.includes(one))
  if (unknown.length > 0)
    throw new CliError(
      "validation_error",
      `no profile named ${unknown.map((one) => `"${one}"`).join(", ")} — ${listed}`,
      { profiles: here },
    )
  return { set: { option: names.join(","), profiles: () => names, key: `_${names.join(",")}` } }
}

const withProfiles = (command: Command): Command =>
  command.option(
    "--profiles <names|all>",
    "serve several profiles from one server instead of one: names, comma-separated, or all for every profile",
  )

/** Where `mcp serve --http` keeps the hashes of the tokens it issued — per profile, in the state folder. */
export const httpTokenFile = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv): string =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "mcp-http", `${profile}.json`)

const withFlags = (command: Command, example: string): Command =>
  command.option(
    "--permission <key=level>",
    `make a permission stricter for this server only, like ${example}; it never loosens the profile; repeat for more keys`,
    (value: string, previous: string[] = []) => [...previous, value],
  )

/**
 * What the `mcp` group needs of the CLI it serves. A messenger serves through its one connection (`messengerHost`);
 * a CLI that is not a messenger through its own program (`appMcpCommand`). The commands, flags and answers are the
 * same in both, so every WireCat CLI has one `mcp`.
 */
export interface McpHost {
  app: AppIdentity
  /** `Telegram`, `Google Calendar`: what the instructions call the service. */
  name: string
  resolveSettings: (flags: GlobalFlags, options?: ResolveOptions) => Settings
  context: (self: Command, options?: { needsProfile?: boolean }) => BaseContext
  /** A permission key of this CLI for `--permission`'s help: `messages.send=deny`. */
  permissionExample: string
  serveStdio: (self: Command, context: BaseContext) => Promise<void>
  serveHttp: (
    self: Command,
    context: BaseContext,
    http: Omit<HttpOptions, "onCode" | "onError" | "appName">,
  ) => Promise<void>
  /** The instructions of the server of several profiles, whose tools each take `profile`. */
  instructions: (profiles: readonly string[]) => string | Promise<string>
  /** Whether the profile can reach the service; `undefined` where the CLI cannot tell without connecting. */
  signedIn: (self: Command, profile: string, env: NodeJS.ProcessEnv) => boolean | undefined
  /** A profile that is a bot, or not signed in here; the server of several profiles leaves bots out. */
  profileState?: Messenger["profileState"]
}

const messengerHost = (messenger: Messenger): McpHost => ({
  app: messenger.app,
  name: messenger.name ?? messenger.app.command,
  resolveSettings: messenger.resolveSettings,
  ...(messenger.profileState ? { profileState: messenger.profileState } : {}),
  context: (self, options) => messengerContext(self, messenger, options),
  permissionExample: "messages.send=deny",
  serveStdio: async (self, context) => {
    // Loaded here, not at the top: every other command would otherwise pay for the SDK.
    const { serveOverStdio } = await import("../../mcp/server.js")
    await serveOverStdio(self, context as MessengerContext, messenger, {})
  },
  serveHttp: async (self, context, http) => {
    const { serveOverHttpUntilStopped } = await import("../../mcp/server.js")
    await serveOverHttpUntilStopped(self, context as MessengerContext, messenger, {}, http)
  },
  instructions: async (profiles) => {
    const { instructions } = await import("../../mcp/instructions.js")
    return instructions({
      command: messenger.app.command,
      name: messenger.name ?? messenger.app.command,
      profile: profiles,
      writes: [],
    })
  },
  signedIn: (self, profile, env) =>
    (messenger.accountOf?.(self) ?? recalledAccount(messenger.app, messenger.provider, profile, env)) !== undefined,
})

export const mcpCommand = (messenger: Messenger): Command => mcpGroup(messengerHost(messenger))

export const mcpGroup = (host: McpHost): Command => {
  const { app } = host
  const flagged = (command: Command) => withFlags(command, host.permissionExample)
  const command = annotate(new Command("mcp"), { effects: LOCAL_READ, mcp: false })
    .summary("serve this profile's commands to an AI agent, and set that up")
    .description(
      `serve this profile to an agent over MCP and set it up — \`claude mcp add ${app.command} -- ${app.command} <profile> mcp serve\``,
    )
  command.addCommand(
    withProfiles(
      flagged(
        annotate(new Command("serve"), {
          effects: REMOTE_WRITE,
          lifetime: "persistent",
          mcp: false,
          examples: [
            `${app.command} personal mcp serve`,
            `${app.command} mcp serve --profiles work,personal`,
            `${app.command} personal mcp serve --http --public-url https://laptop.example.ts.net`,
          ],
        })
          .summary("serve this profile's commands to an AI agent")
          .description(
            `serve this profile to an agent over MCP, on stdin and stdout — \`claude mcp add ${app.command} -- ${app.command} <profile> mcp serve\`; \`${app.command} mcp serve --profiles a,b\` or \`--profiles all\` serves those profiles from one server and each tool asks which`,
          ),
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
      .action(async function (this: Command) {
        const flags = this.optsWithGlobals<McpFlags>()
        const context = host.context(this, { needsProfile: false })
        const served = servedProfiles(this, host, context, flags.profiles, "mcp serve")
        if ("set" in served) return serveProfiles(this, context, host, flags, served.set)
        const { profile } = served
        if (flags.http) {
          const publicUrl = publicUrlOf(flags.publicUrl, {
            missing: "--http",
            reaches: `the browser apps reach ${app.command}`,
            path: true,
          })
          const tokenFile = httpTokenFile(app, profile, context.env)
          await host.serveHttp(this, context, {
            publicUrl,
            port: portOf(flags.port, DEFAULT_PORT),
            tokenFile,
            lockFile: httpLockFile(tokenFile),
            version: app.version,
          })
          return
        }
        await host.serveStdio(this, context)
      }),
  )

  command.addCommand(
    withProfiles(
      annotate(new Command("revoke"), {
        effects: LOCAL_WRITE,
        mcp: false,
        examples: [`${app.command} personal mcp revoke`, `${app.command} mcp revoke --profiles all`],
      })
        .summary("forget every login given to a browser app")
        .description(
          "forget every login `mcp serve --http` gave a browser app, of this profile or of the server `--profiles` names; each app must log in again",
        ),
    ).action(async function (this: Command) {
      const context = host.context(this, { needsProfile: false })
      const served = servedProfiles(this, host, context, this.opts<McpFlags>().profiles, "mcp revoke")
      const { revokeAll } = await import("../../mcp/http/oauth.js")
      revokeAll(httpTokenFile(app, "set" in served ? served.set.key : served.profile, context.env))
      renderAnswer(
        this,
        context,
        itemOf(
          "set" in served
            ? { revoked: true, profile: null, profiles: served.set.option }
            : { revoked: true, profile: served.profile },
        ),
      )
    }),
  )
  command.addCommand(
    mcpServerCommand({
      example: `${app.command} personal`,
      permission: true,
      profiles: true,
      target: (self) => {
        const context = host.context(self, { needsProfile: false })
        const { env } = context
        const served = servedProfiles(self, host, context, self.opts<McpFlags>().profiles, `mcp server ${self.name()}`)
        if ("set" in served) {
          const { set } = served
          return {
            invocation: app.command,
            profiles: { option: set.option, key: set.key, label: profileSetLabel(set) },
            envPrefix: app.envPrefix,
            env,
            tokenFile: httpTokenFile(app, set.key, env),
            argv: ["mcp", "serve", "--http", "--profiles", set.option],
            version: app.version,
          }
        }
        const { profile } = served
        return {
          invocation: `${app.command} ${profile}`,
          profile,
          envPrefix: app.envPrefix,
          env,
          tokenFile: httpTokenFile(app, profile, env),
          argv: ["mcp", "serve", "--http"],
          childEnv: { [`${app.envPrefix}_PROFILE`]: profile },
          version: app.version,
        }
      },
      answer: (self, item, lines) =>
        renderAnswer(self, host.context(self, { needsProfile: false }), itemOf(item), () => lines.join("\n")),
      system: (self) => environmentOf<McpEnvironment>(self).system,
    }),
  )
  command.addCommand(
    withProfiles(
      flagged(
        annotate(new Command("config"), {
          effects: LOCAL_READ,
          examples: [`${app.command} personal mcp config`, `${app.command} mcp config --profiles all`],
        })
          .summary("print the local MCP configuration of this profile, or of those --profiles names")
          .description(
            "print the mcpServers entry for Claude Desktop, Cursor and others, with full paths; writes nothing",
          ),
      ),
    ).action(async function (this: Command) {
      const flags = this.optsWithGlobals<McpFlags>()
      const context = host.context(this, { needsProfile: false })
      const { env } = context
      const given = environmentOf<McpEnvironment>(this).mcp ?? {}
      const served = servedProfiles(this, host, context, flags.profiles, "mcp config")
      const entry = serverEntry(app, {
        ...("set" in served ? { profiles: served.set.option } : { profile: served.profile }),
        flags,
        execPath: given.execPath ?? process.execPath,
        scriptPath: given.scriptPath ?? realpathSync(process.argv[1] ?? ""),
        env,
      })
      // Pasted into a file, so a person gets the client's own JSON, indented; a script finds it under `config`.
      renderAnswer(
        this,
        context,
        itemOf(
          { config: entry.config },
          {
            next: entry.nodeBound
              ? [nextStep("mcp.config", { args: { profiles: "set" in served ? served.set.option : undefined } })]
              : [],
          },
        ),
        () => JSON.stringify(entry.config, null, 2),
      )
    }),
  )
  command.addCommand(
    flagged(
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
      const context = host.context(this)
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
    flagged(
      annotate(new Command("check"), {
        effects: LOCAL_READ,
        examples: [`${app.command} personal mcp check`],
      }).description("check this profile's local MCP handshake and tool list"),
    ).action(async function (this: Command) {
      const context = host.context(this)
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
        const signedIn = host.signedIn(this, settings.profile, env)
        if (signedIn === false) {
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
            healthy: signedIn !== false,
            profile: settings.profile,
            signed_in: signedIn ?? null,
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

/** How the startup and status lines name a set, so the owner sees which accounts an agent reaches. */
export const profileSetLabel = (set: ProfileSet): string => {
  const names = set.profiles().join(", ")
  if (set.option === EVERY_PROFILE) return `every profile (${names || "none yet"})`
  return set.profiles().length === 1 ? `profile ${names}` : `profiles ${names}`
}

/**
 * `<tool> mcp serve --profiles <names|all>`: those profiles from one server, each call in that profile's own
 * `<tool> <profile> mcp serve` (`src/mcp/all-profiles.ts`). Nothing picks a profile: each tool takes one, and the
 * agent is told to ask.
 */
const serveProfiles = async (self: Command, context: BaseContext, host: McpHost, flags: McpFlags, set: ProfileSet) => {
  const { app } = host
  const { env } = context
  const tokenFile = httpTokenFile(app, set.key, env)
  const state = (profile: string) => host.profileState?.(profile, env) ?? "signed-in"
  const bots = set.option === EVERY_PROFILE ? [] : set.profiles().filter((profile) => state(profile) === "bot")
  if (bots.length > 0)
    throw new CliError(
      "validation_error",
      `${bots.join(", ")} ${bots.length === 1 ? "is a bot profile" : "are bot profiles"}, served by \`${app.command} <profile> bot mcp serve\``,
    )
  // `all` reads the profiles again for each session, so one set up while the server runs appears.
  const profiles = () => set.profiles().filter((profile) => state(profile) !== "bot")
  if (profiles().length === 0)
    throw new CliError(
      "configuration_error",
      `no ${app.command} profile on this computer yet — set one up, then run \`${app.command} mcp serve --profiles all\` again`,
    )
  const given = environmentOf<McpEnvironment>(self).mcp ?? {}
  const execPath = given.execPath ?? process.execPath
  const scriptPath = given.scriptPath ?? realpathSync(process.argv[1] ?? "")
  const tightened = (flags.permission ?? []).flatMap((entry) => ["--permission", entry])
  const options = {
    command: app.command,
    version: app.version,
    name: host.name,
    profiles,
    signedIn: (profile: string) => state(profile) === "signed-in",
    signIn: (profile: string) =>
      `profile ${profile} is not signed in — run \`${app.command} ${profile} setup\`, or sign in from WireCat Desktop, ` +
      "then try again. If the owner did not choose this profile, ask which one.",
    child: (profile: string) => ({ command: execPath, args: [scriptPath, profile, "mcp", "serve", ...tightened], env }),
    instructions: await host.instructions(profiles()),
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
            : `a new login code for a browser app: \`${app.command} mcp server status --profiles ${set.option}\``,
        ),
    }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE")
        throw new CliError("configuration_error", `port ${port} is in use — pass another with --port`)
      throw error
    })
    context.renderer.note(
      `serving ${profileSetLabel(set)} on ${listening.url.href} — point your tunnel at it; connectors use ${mcpUrlOf(publicUrl).href}`,
    )
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve)
      process.once("SIGTERM", resolve)
    })
    await listening.close()
    return
  }
  const { serveAllProfilesOverStdio } = await import("../../mcp/all-profiles.js")
  context.renderer.note(`serving ${profileSetLabel(set)} over MCP on stdin and stdout`)
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

/** `tg-work`; `tg` for every profile; `tg-personal-work` for a list, a name every client accepts. */
const serverName = (app: AppIdentity, profile: string | undefined, profiles: string | undefined) => {
  if (profile !== undefined) return `${app.command}-${profile}`
  if (profiles === EVERY_PROFILE) return app.command
  return `${app.command}-${(profiles ?? "").split(",").join("-")}`
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
    profiles,
    flags = {},
    execPath,
    scriptPath,
    env,
  }: {
    /** One profile, or `profiles`: the `--profiles` of a server of several. */
    profile?: string
    profiles?: string
    flags?: McpFlags
    execPath: string
    scriptPath: string
    env: NodeJS.ProcessEnv
  },
): { config: { mcpServers: Record<string, object> }; nodeBound: boolean } => {
  if ((profile === undefined) === (profiles === undefined))
    throw new CliError("validation_error", "an MCP entry serves one profile or the profiles --profiles names")
  const words = profile === undefined ? `mcp config --profiles ${profiles}` : `${profile} mcp config`
  if (installerOf(scriptPath) === "npx") {
    throw new CliError(
      "validation_error",
      `this ${app.command} runs from npx's cache, which gets cleared, and the path would stop working — ` +
        `install it globally, then run \`${app.command} ${words}\` again`,
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
      ...(profiles === undefined ? [] : ["--profiles", profiles]),
      ...(flags.permission ?? []).flatMap((entry) => ["--permission", entry]),
    ],
    ...(Object.keys(directories).length > 0 ? { env: directories } : {}),
  }
  return {
    config: { mcpServers: { [serverName(app, profile, profiles)]: server } },
    /** The path belongs to one Node version of a version manager; switching Node breaks the entry. */
    nodeBound: VERSION_MANAGER.test(execPath),
  }
}
