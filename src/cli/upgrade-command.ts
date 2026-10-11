import type { Renderer, RenderFormat } from "@wirecat/cli-base"
import { Command } from "commander"
import { type PackageUpgradePorts, type PackageUpgradeResult, upgradePackage } from "../services/package-upgrade.js"
import type { AppIdentity } from "./app.js"

export interface UpgradeContext extends Omit<PackageUpgradePorts, "onInstall"> {
  renderer: Renderer
  format: RenderFormat
}

export const upgradeCommand = (
  app: AppIdentity,
  packageName: string,
  contextFor: (command: Command) => UpgradeContext,
): Command =>
  new Command("upgrade")
    .description(`upgrade ${app.command} with the package manager that installed it; --check only looks`)
    .option("--check", "say whether a newer version exists, and install nothing")
    .action(async function (this: Command, { check }: { check?: boolean }) {
      const context = contextFor(this)
      const { renderer, format } = context
      const { result, reason, left } = await upgradePackage(
        { current: app.version, command: app.command, packageName, check: check === true },
        { ...context, onInstall: (argv) => renderer.note(`running: ${argv.join(" ")}`) },
      )
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
      renderer.result(format === "pretty" ? summary(app.command, result) : result)
    })

const summary = (command: string, result: PackageUpgradeResult): string => {
  if (result.updated) {
    const servers =
      result.restarted.length > 0
        ? `; restarted the server for ${result.restarted.map((profile) => `profile ${profile}`).join(", ")}`
        : ""
    return `${command} ${result.current} → ${result.latest}${servers}`
  }
  return result.latest === null
    ? `${command} ${result.current}; npm did not answer`
    : result.newer
      ? `${command} ${result.latest} is out — you have ${result.current}`
      : `${command} ${result.current} is the newest`
}
