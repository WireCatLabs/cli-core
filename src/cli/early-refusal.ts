import type { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"
import { type AppIdentity, MESSENGER_CHANGE_REFUSAL, readOnlyLockOf, readOnlyRefusal } from "../ports/app.js"
import { levelRefusal } from "../sends/guard.js"
import { SendJournal, sendsPathFor } from "../sends/journal.js"
import { keyForCommand, levelFor, writeOfKey } from "../sends/permissions.js"
import { newOperationId } from "../sends/send-id.js"
import { commandPathOf } from "./command-contract.js"
import { changesMessenger } from "./effects.js"
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
