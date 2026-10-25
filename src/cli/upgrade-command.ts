import { spawnSync } from "node:child_process"
import { CliError, type Renderer, type RenderFormat, type Streams } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { servingProfiles } from "../background/lock.js"
import type { AppIdentity } from "../ports/app.js"
import { type PackageUpgradePorts, type PackageUpgradeResult, upgradePackage } from "../services/package-upgrade.js"
import { grantsAuthority, LOCAL_WRITE } from "./effects.js"
import { itemOf, renderAnswer, snakeKeys } from "./envelope.js"
import { usableProfileName } from "./profile.js"

export interface UpgradeContext extends Omit<PackageUpgradePorts, "onInstall"> {
  renderer: Renderer
  format: RenderFormat
  streams: Streams
}

/**
 * A running serve keeps the code it started with; the update replaced the files under it. Each is restarted by
 * the new `script` — `server restart` refuses a serve started by hand, which is then named in `left`.
 * `spawn` replaces the child process, as in `UpdateEnvironment`.
 */
export const restartServers = (
  app: AppIdentity,
  script: string,
  env: NodeJS.ProcessEnv,
  spawn?: (argv: string[]) => number,
) => {
  const restarted: string[] = []
  const left: string[] = []
  for (const profile of servingProfiles(app, env)) {
    try {
      usableProfileName(profile)
    } catch {
      continue
    }
    const argv = [script, profile, "server", "restart"]
    const code = spawn
      ? spawn([process.execPath, ...argv])
      : (spawnSync(process.execPath, argv, { env, shell: false, stdio: ["ignore", 2, 2] }).status ?? 1)
    ;(code === 0 ? restarted : left).push(profile)
  }
  return { restarted, left }
}

export const upgradeCommand = (
  app: AppIdentity,
  packageName: string,
  contextFor: (command: Command) => UpgradeContext,
): Command =>
  grantsAuthority(
    annotate(new Command("upgrade"), {
      effects: LOCAL_WRITE,
      offline: false,
      examples: [`${app.command} upgrade --check`, `${app.command} upgrade`],
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
      const { result, reason, left } = await upgradePackage(
        { current: app.version, command: app.command, packageName, check: check === true },
        { ...context, onInstall: (argv) => renderer.note(`running: ${argv.join(" ")}`) },
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
          `the server for profile ${profile} still runs ${app.command} ${app.version} — ` +
            `\`${app.command} ${profile} server restart\``,
        )
      }
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
    return `${command} ${result.current} → ${result.installed ?? result.latest}${held}${servers}`
  }
  if (held) return `${command} ${result.current}${held}`
  return result.latest === null
    ? `${command} ${result.current}; npm did not answer`
    : result.newer
      ? `${command} ${result.latest} is out — you have ${result.current}`
      : `${command} ${result.current} is the newest`
}
