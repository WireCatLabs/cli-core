import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { storePath } from "../store/path.js"
import { readSharedSection, sharedConfigPath, writeSharedSection } from "../store/shared-config.js"
import { modelAddressAllowed, onThisComputer, PLAIN_HTTP_REFUSED } from "./endpoint.js"

const SECTION = "local_only"

const Setting = v.strictObject({
  on: v.boolean(),
  at: v.pipe(v.string(), v.isoTimestamp()),
})

export type LocalOnlySetting = v.InferOutput<typeof Setting>

const pathOf = (env: NodeJS.ProcessEnv) => sharedConfigPath(storePath(env), env)

/** The owner's switch, off when absent. A broken section reads as on: a typo must not let records out. */
export const readLocalOnly = (env: NodeJS.ProcessEnv): LocalOnlySetting | undefined => {
  const section = readSharedSection(pathOf(env), SECTION)
  if (section === undefined || section === null) return undefined
  const checked = v.safeParse(Setting, section)
  return checked.success ? checked.output : { on: true, at: new Date(0).toISOString() }
}

export const localOnly = (env: NodeJS.ProcessEnv): boolean => readLocalOnly(env)?.on === true

export const writeLocalOnly = (env: NodeJS.ProcessEnv, on: boolean): void =>
  writeSharedSection(pathOf(env), SECTION, on ? { on: true, at: new Date().toISOString() } : undefined)

export const localOnlyRefusal = (what: string, where: string): CliError =>
  new CliError(
    "permission_error",
    `local only is on: ${what} would go to ${where}, which is not this computer; nothing was sent. ` +
      "Choose a model on this computer, or turn local only off with `models local-only set off`",
    { reason: "local-only.refused" },
  )

/** Throws when local only is on and the address is not on this computer. */
export const refuseOffComputer = (env: NodeJS.ProcessEnv, address: string, what: string): void => {
  if (!onThisComputer(address) && localOnly(env)) throw localOnlyRefusal(what, hostOf(address))
}

const hostOf = (address: string) => {
  try {
    return new URL(address).host
  } catch {
    return address
  }
}

/** What a setting command checks before it saves an address: https or this computer, and local only. */
export const refuseModelAddress = (env: NodeJS.ProcessEnv, address: string, what: string): void => {
  if (!modelAddressAllowed(address))
    throw new CliError("validation_error", PLAIN_HTTP_REFUSED, { reason: "model.address-refused" })
  refuseOffComputer(env, address, what)
}
