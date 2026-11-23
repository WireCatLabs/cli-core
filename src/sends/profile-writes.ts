import type { AppIdentity } from "../ports/app.js"
import type { Warn } from "../runs/events.js"
import { type Asker, type GuardSettings, guardFor, type SendGuard } from "./guard.js"
import { keyedGuard } from "./keyed-guard.js"
import { DEFAULT_PERMISSIONS, type Level, levelFor, type PermissionKey } from "./permissions.js"

/** What a CLI hands a service's writes (a CRM's, a site's, a tracker's) for one profile. */
export interface ProfileWrites {
  app: AppIdentity
  /**
   * The profile's levels, read on every write so a config change applies at once. A service limits its own rate, so
   * `sendsPerHour` is not read: the guard is there for the levels and the journal.
   */
  settings: () => Omit<GuardSettings, "sendsPerHour"> & Partial<Pick<GuardSettings, "sendsPerHour">>
  env?: NodeJS.ProcessEnv
  warn?: Warn
}

const levelsOf = (writes: ProfileWrites, defaults: Readonly<Record<PermissionKey, Level>>) => {
  const settings = writes.settings()
  return { settings, defaults: { ...DEFAULT_PERMISSIONS, ...defaults, ...settings.permissionDefaults } }
}

/** The profile's guard over a write's own key and the keys its fields imply (`keyedGuard`). */
export const profileWriteGuard = (
  writes: ProfileWrites,
  ask: Asker,
  builtIn: Readonly<Record<PermissionKey, Level>>,
  extra: readonly PermissionKey[],
): SendGuard => {
  const { settings, defaults } = levelsOf(writes, builtIn)
  return keyedGuard(
    (asker) =>
      guardFor(
        writes.app,
        { ...settings, sendsPerHour: Number.MAX_SAFE_INTEGER, permissionDefaults: defaults },
        writes.warn ?? (() => {}),
        writes.env,
        asker,
      ),
    ask,
    (key) => levelFor(settings.permissions, key, defaults).level,
    extra,
  )
}

/**
 * The keys at level `ask`: the owner is asked about them here, so a writer over the `api` group need not ask again. A
 * key at `allow` was asked about by nobody and confirms nothing.
 */
export const askedKeys = (
  writes: ProfileWrites,
  builtIn: Readonly<Record<PermissionKey, Level>>,
  keys: readonly PermissionKey[],
): PermissionKey[] => {
  const { settings, defaults } = levelsOf(writes, builtIn)
  return keys.filter((key) => levelFor(settings.permissions, key, defaults).level === "ask")
}
