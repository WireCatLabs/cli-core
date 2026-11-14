import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import { levelFor } from "../sends/permissions.js"
import { commandPathOf } from "./command-contract.js"
import { environmentOf, withAgentLevels } from "./context.js"
import { terminalAsker } from "./messenger/ask.js"
import { commandPathKey } from "./permission-keys.js"

/**
 * The `ask` step of a declared CLI's write that has no guard of its own (`meetings create`): `deny` and `readonly`
 * already stopped it before it ran (`refuseByCommandPermissions`), and `ask` is left to the command. At `ask` the owner
 * is asked, `--yes` answers, an agent goes ahead, and with nobody to answer it refuses. Outside the CLI's run, where
 * the profile's levels are not known, it refuses too.
 */
export const askBeforeWrite = async (command: Command): Promise<void> => {
  const key = commandPathKey(commandPathOf(command))
  if (!key) return
  const environment = environmentOf(command)
  if (!environment.resolveSettings)
    throw new CliError("configuration_error", `${key} reads its permission level inside the tool's run only`)
  const settings = environment.resolveSettings(withAgentLevels(command, command.optsWithGlobals()), {
    env: environment.env ?? process.env,
    needsProfile: false,
    readOnly: true,
  })
  const { level } = levelFor(settings.permissions, key, environment.permissionDefaults)
  if (level === "ask") await terminalAsker(command)(key, { chatId: null, kind: "edit", key })
}
