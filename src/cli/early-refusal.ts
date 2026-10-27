import { CliError } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import { writes } from "@wirecat/cli-base/standards"
import type { Command } from "commander"
import { type AppIdentity, MESSENGER_CHANGE_REFUSAL, readOnlyLockOf, readOnlyRefusal } from "../ports/app.js"
import { ceilingRefusal, levelRefusal } from "../sends/guard.js"
import { SendJournal, sendsPathFor } from "../sends/journal.js"
import { CEILING_KEY, keyForCommand, levelFor, writeOfKey } from "../sends/permissions.js"
import { newOperationId } from "../sends/send-id.js"
import { commandPathOf } from "./command-contract.js"
import { environmentOf } from "./context.js"
import { changesMessenger } from "./effects.js"
import { type CommandPermissions, refuseUnknownPermissionKeys } from "./permission-keys.js"
import { NONE_NAMED, type Settings, settingsFor } from "./settings.js"

type Resolve = (flags: object, options: { env: NodeJS.ProcessEnv; needsProfile: false; readOnly: true }) => object

/**
 * Refuses a change on the messenger the read-only lock or the profile's level stops, before anything connects
 * (SEC-62). The send guard would refuse it too, but only after the command connected and found its chat. The journal
 * gets the shorter line this knows: the command's key and kind, and the chat only when the command was given its id.
 * A preview journals nothing, and the lock refuses it as well: it answers as the write would (SEC-65).
 */
export const refuseWriteBeforeConnecting = (
  action: Command,
  { app, env, dryRun, resolve }: { app: AppIdentity; env: NodeJS.ProcessEnv; dryRun: boolean; resolve?: Resolve },
): void => {
  if (!changesMessenger(action)) return
  const path = commandPathOf(action)
  const lock = readOnlyLockOf(app, env)
  // A bot keeps its own settings, journal and wording of the fix.
  if (path[0] === "bot") {
    if (lock) throw readOnlyRefusal(lock, MESSENGER_CHANGE_REFUSAL)
    return
  }
  if (!lock && dryRun) return
  const key = keyForCommand(path)
  if (!key) return
  const settings = (resolve ?? settingsFor(app).resolveSettings)(action.optsWithGlobals(), {
    env,
    needsProfile: false,
    readOnly: true,
  }) as Partial<Pick<Settings, "profile" | "permissions" | "permissionSources" | "sources">>
  const named = settings.profile !== undefined && settings.sources?.profile !== NONE_NAMED
  let refusal: CliError | undefined
  if (lock) refusal = readOnlyRefusal(lock, MESSENGER_CHANGE_REFUSAL)
  else if (named && settings.permissions) {
    const { level, key: from } = levelFor(settings.permissions, key)
    if (level === "deny" || level === "readonly")
      refusal = levelRefusal({
        profile: settings.profile as string,
        command: app.command,
        key,
        level,
        named: from,
        permissionSources: settings.permissionSources ?? {},
      })
  }
  if (!refusal) return
  if (named && !dryRun) {
    const chat = action.registeredArguments.findIndex((argument) => argument.name() === "chat")
    const given: unknown = chat < 0 ? undefined : action.processedArgs[chat]
    new SendJournal(sendsPathFor(app, settings.profile as string, env), {
      service: app.command,
      version: app.version,
    }).append({
      at: new Date().toISOString(),
      profile: settings.profile as string,
      chatId: typeof given === "string" && /^-?\d+$/.test(given) ? given : null,
      ...writeOfKey(key),
      key,
      operationId: newOperationId(),
      outcome: "refused",
      errorCode: refusal.code,
    })
  }
  throw refusal
}

/**
 * A command of a CLI that declares its own keys (`commandPermissions`), refused by its key before anything connects:
 * `deny` stops it, `readonly` stops a write, and the read-only lock stops a write to the service. `ask` is left to
 * the write guard, which can put the question. A saved or `--permission` key that names no command stops every keyed
 * command; housekeeping still runs, so `config unset` can remove it.
 */
export const refuseByCommandPermissions = (
  action: Command,
  permissions: CommandPermissions,
  { app, env, dryRun, resolve }: { app: AppIdentity; env: NodeJS.ProcessEnv; dryRun: boolean; resolve: Resolve },
): void => {
  const key = permissions.keyOf(commandPathOf(action))
  if (!key) return
  const { effects } = metaOf(action)
  const lock = readOnlyLockOf(app, env)
  if (lock && effects?.remote === "write") throw readOnlyRefusal(lock, `run ${commandPathOf(action).join(" ")}`)
  const flags = action.optsWithGlobals<{ permission?: string[] }>()
  const overrides = environmentOf(action).agent?.overrides ?? []
  const settings = resolve(
    overrides.length > 0 ? { ...flags, permission: [...overrides, ...(flags.permission ?? [])] } : flags,
    { env, needsProfile: false, readOnly: true },
  ) as Pick<Settings, "profile" | "permissions" | "permissionSources" | "configPath"> &
    Partial<Pick<Settings, "savedPermissions" | "sources">>
  refuseUnknownPermissionKeys(action, settings, app.command, permissions)
  if (dryRun || settings.sources?.profile === NONE_NAMED) return
  const { level, key: named } = levelFor(settings.permissions, key, permissions.defaults)
  if (level === "deny") {
    if (named === CEILING_KEY) throw ceilingRefusal(key, app.command)
    throw new CliError(
      "permission_error",
      `profile ${settings.profile} denies ${key} (permissions.${named} is deny, from the ` +
        `${settings.permissionSources[named ?? ""] ?? "default"})`,
      { permission: key },
    )
  }
  if (level === "readonly" && effects !== undefined && writes(effects))
    throw levelRefusal({
      profile: settings.profile,
      command: app.command,
      key,
      level,
      named,
      permissionSources: settings.permissionSources,
    })
}
