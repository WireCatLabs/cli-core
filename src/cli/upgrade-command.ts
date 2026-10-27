import { spawnSync } from "node:child_process"
import { CliError, type Renderer, type RenderFormat, type Streams } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import {
  type AfterUpgradeSystem,
  type McpServerRestart,
  restartMcpServers,
  type StaleSessions,
  staleMcpSessions,
  thisSystem,
} from "../background/after-upgrade.js"
import { servingProfiles } from "../background/lock.js"
import type { AppIdentity } from "../ports/app.js"
import {
  type PackageUpgradePorts,
  type PackageUpgradeResult,
  type ServerRestarts,
  upgradePackage,
} from "../services/package-upgrade.js"
import { type BaseEnvironment, environmentOf } from "./context.js"
import { grantsAuthority, LOCAL_WRITE } from "./effects.js"
import { itemOf, renderAnswer, snakeKeys } from "./envelope.js"
import { usableProfileName } from "./profile.js"

export interface UpgradeContext extends Omit<PackageUpgradePorts, "onInstall"> {
  renderer: Renderer
  format: RenderFormat
  streams: Streams
}

/** `server restart` waits 30 s for serve to stop and 30 s for it to listen; this is a ceiling over both. */
const RESTART_CEILING_MS = 90_000
const TIMEOUT_EXIT = 9

/**
 * A running serve keeps the code it started with; the update replaced the files under it. Each is restarted by
 * the new `script` — `server restart` refuses a serve started by hand, which is then named in `left`, and one that
 * ran out of time is named in `timedOut` too. `spawn` replaces the child process, as in `UpdateEnvironment`.
 */
export const restartServers = (
  app: AppIdentity,
  script: string,
  env: NodeJS.ProcessEnv,
  spawn?: (argv: string[]) => number,
) => {
  const restarted: string[] = []
  const left: string[] = []
  const timedOut: string[] = []
  for (const profile of servingProfiles(app, env)) {
    try {
      usableProfileName(profile)
    } catch {
      continue
    }
    const argv = [script, profile, "server", "restart"]
    const code = spawn
      ? spawn([process.execPath, ...argv])
      : (spawnSync(process.execPath, argv, {
          env,
          shell: false,
          stdio: ["ignore", 2, 2],
          timeout: RESTART_CEILING_MS,
        }).status ?? TIMEOUT_EXIT)
    ;(code === 0 ? restarted : left).push(profile)
    if (code === TIMEOUT_EXIT) timedOut.push(profile)
  }
  return timedOut.length > 0 ? { restarted, left, timedOut } : { restarted, left }
}

const RESTART_FROM_APP = "restart them from your agent app (start a new chat, or reload its MCP servers)"

const mcpWarnings = (command: string, current: string, servers: readonly McpServerRestart[], stale?: StaleSessions) => [
  ...servers.flatMap((server) =>
    !server.restarted
      ? [`the HTTP MCP server ${server.name} (PID ${server.pid}) was not restarted: ${server.reason}`]
      : server.to !== null && server.to === server.from
        ? [
            `the HTTP MCP server ${server.name} came back on ${command} ${server.to}: it runs from another install than the one upgraded`,
          ]
        : [],
  ),
  ...(stale === undefined
    ? []
    : !stale.checked
      ? [
          `could not check for MCP sessions over stdio (${stale.reason}); any that run keep ${command} ${current} or older — ${RESTART_FROM_APP}`,
        ]
      : stale.sessions.length > 0
        ? [
            `${stale.sessions.length} MCP ${stale.sessions.length === 1 ? "session" : "sessions"} over stdio still ${stale.sessions.length === 1 ? "runs" : "run"} ${command} ${current} or older ` +
              `(PID ${stale.sessions.map((session) => session.pid).join(", ")}) — ${RESTART_FROM_APP}`,
          ]
        : []),
]

export const upgradeCommand = (
  app: AppIdentity,
  packageName: string,
  contextFor: (command: Command) => UpgradeContext,
): Command =>
  grantsAuthority(
    annotate(new Command("upgrade"), {
      effects: LOCAL_WRITE,
      offline: false,
      examples: [`${app.command} upgrade --check`],
    }),
    { unless: "check" },
  )
    .description(`upgrade ${app.command} with the package manager that installed it; --check only looks`)
    .option("--check", "say whether a newer version exists, and install nothing")
    .action(async function (this: Command, { check }: { check?: boolean }) {
      if (this.optsWithGlobals<{ offline?: boolean }>().offline)
        throw new CliError(
          "validation_error",
          `\`${app.command} upgrade\` asks npm for the newest version; not with --offline`,
        )
      const context = contextFor(this)
      const { renderer } = context
      const environment = environmentOf<BaseEnvironment & { afterUpgrade?: Partial<AfterUpgradeSystem> }>(this)
      const env = environment.env ?? process.env
      // Built before the install: after it, the old process may no longer find its own lazily loaded files.
      const system = { ...thisSystem(packageName, app.command), ...environment.afterUpgrade }
      const afterUpdate = async (): Promise<ServerRestarts> => {
        const servers = (await context.afterUpdate?.()) ?? { restarted: [], left: [] }
        return {
          ...servers,
          mcpServers: await restartMcpServers(app, env, system),
          staleSessions: staleMcpSessions(system),
        }
      }
      const { result, reason, left, timedOut } = await upgradePackage(
        { current: app.version, command: app.command, packageName, check: check === true },
        { ...context, afterUpdate, onInstall: (argv) => renderer.note(`running: ${argv.join(" ")}`) },
      )
      if (reason === "held_back" && result.heldBack) renderer.warn(heldBackAdvice(result, result.heldBack))
      if (reason === "unavailable") renderer.warn("npm did not answer, so nothing was run")
      else if (reason === "up_to_date") renderer.note(`${app.command} ${app.version} is the newest`)
      else if (reason === "manual") {
        const advice =
          result.installer === "checkout"
            ? "this is a checkout: `git pull && pnpm install && pnpm build`"
            : result.installer === "npx"
              ? `npx runs whatever version it is asked for: \`npx ${packageName}@latest\``
              : `cannot tell how ${app.command} was installed, so nothing was run`
        renderer.warn(advice)
      }
      for (const profile of left) {
        renderer.warn(
          timedOut?.includes(profile)
            ? `the server for profile ${profile} did not restart in time and may still run ${app.command} ${app.version} — ` +
                `\`${app.command} ${profile} server status\``
            : `the server for profile ${profile} still runs ${app.command} ${app.version} — ` +
                `\`${app.command} ${profile} server restart\``,
        )
      }
      for (const line of mcpWarnings(app.command, app.version, result.mcpServers ?? [], result.staleSessions))
        renderer.warn(line)
      renderAnswer(this, context, itemOf(snakeKeys(result)), () => summary(app.command, result))
    })

const heldBackAdvice = (
  { installed, latest, installer }: PackageUpgradeResult,
  { until, command }: NonNullable<PackageUpgradeResult["heldBack"]>,
): string => {
  const why =
    installer === "pnpm"
      ? `: pnpm installs a version only once it is older than its minimum release age (1 day by default${until ? `, so after ${until}` : ""})`
      : ""
  return `installed ${installed}, not ${latest}${why} — \`${command}\` installs it now`
}

const summary = (command: string, result: PackageUpgradeResult): string => {
  const held = result.heldBack ? `; ${result.latest} is held back` : ""
  if (result.updated) {
    const servers =
      result.restarted.length > 0
        ? `; restarted the server for ${result.restarted.map((profile) => `profile ${profile}`).join(", ")}`
        : ""
    const mcp = (result.mcpServers ?? []).filter((server) => server.restarted)
    const http =
      mcp.length > 0
        ? `; restarted the HTTP MCP server ${mcp.map((server) => `${server.name} (${server.from ?? "?"} → ${server.to ?? "?"})`).join(", ")}`
        : ""
    return `${command} ${result.current} → ${result.installed ?? result.latest}${held}${servers}${http}`
  }
  if (held) return `${command} ${result.current}${held}`
  return result.latest === null
    ? `${command} ${result.current}; npm did not answer`
    : result.newer
      ? `${command} ${result.latest} is out — you have ${result.current}`
      : `${command} ${result.current} is the newest`
}
