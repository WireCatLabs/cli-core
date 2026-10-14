import { existsSync } from "node:fs"
import { ACCOUNT_GROUPS_SETTING, type AccountGroups, groupMembers, groupName } from "../search/account-list.js"
import { DEFAULT_STEMMERS, parseStemmers, type Stemmers } from "../search/stem.js"
import { openCache } from "../store/open.js"
import { storePath } from "../store/path.js"
import { accountGroupsOf, openStore, savedStemmers, stemmersOrigin } from "../store/store.js"
import type { AppIdentity } from "./app.js"

const SCRIPTS: Record<string, keyof Stemmers> = {
  "search_stemmers.cyrillic": "cyrillic",
  "search_stemmers.latin": "latin",
}

/** Settings of the store file, not of a profile: the store is one file for every profile, tg and MAX. */
export const STORE_SETTINGS = Object.keys(SCRIPTS)

const GROUP_PREFIX = `${ACCOUNT_GROUPS_SETTING}.`

export const isStoreSetting = (setting: string): boolean => setting in SCRIPTS || setting.startsWith(GROUP_PREFIX)

export const changeStoreSetting = async (
  app: AppIdentity,
  env: NodeJS.ProcessEnv,
  setting: string,
  value: string | undefined,
) => {
  if (setting.startsWith(GROUP_PREFIX)) return changeGroup(app, env, setting, value)
  const script = SCRIPTS[setting] as keyof Stemmers
  const store = await openStore({ env })
  try {
    const current = (await store.stemmers()) ?? DEFAULT_STEMMERS
    const next = parseStemmers({ ...current, [script]: value ?? DEFAULT_STEMMERS[script] })
    await store.saveStemmers(next)
    return {
      result: { store: storePath(env), scope: "store", setting, value: next[script] },
      note: "store-wide — every profile, tg and MAX",
      reindex: true,
    }
  } finally {
    await store.close()
  }
}

const changeGroup = async (app: AppIdentity, env: NodeJS.ProcessEnv, setting: string, value: string | undefined) => {
  const name = groupName(setting.slice(GROUP_PREFIX.length))
  const members = value === undefined ? undefined : groupMembers(value)
  const store = await openStore({ env })
  try {
    await store.saveAccountGroup(name, members)
    return {
      result: { store: storePath(env), scope: "store", setting, value: members ?? null },
      note:
        `store-wide — \`--source group:${name}\` searches these accounts from every app; ` +
        `a profile is found once its app has saved something (\`${app.command} config show\`)`,
    }
  } finally {
    await store.close()
  }
}

/** For `config show`: reads the file as it is — never creates, migrates or unseals it to say the defaults apply. */
export const storeSettings = async (env: NodeJS.ProcessEnv) => {
  const path = storePath(env)
  let saved: Stemmers | null | undefined
  let byDefault = false
  let unreadable = false
  let groups: AccountGroups = {}
  if (existsSync(path)) {
    try {
      const database = await openCache(path)
      try {
        const table = database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'store_settings'").get()
        saved = table ? savedStemmers(database) : undefined
        byDefault = table ? stemmersOrigin(database)?.origin === "default" : false
        groups = table ? accountGroupsOf(database) : {}
      } finally {
        database.close()
      }
    } catch {
      unreadable = true
    }
  }
  const stemmers = STORE_SETTINGS.map((setting) => {
    const script = SCRIPTS[setting] as keyof Stemmers
    if (unreadable) return { setting, value: null, from: "store unreadable", scope: "store" }
    if (saved === null) return { setting, value: null, from: "store, unknown to this build", scope: "store" }
    return {
      setting,
      value: (saved ?? DEFAULT_STEMMERS)[script],
      from: saved && !byDefault ? "store" : "default",
      scope: "store",
    }
  })
  return [
    ...stemmers,
    ...Object.entries(groups).map(([name, members]) => ({
      setting: `${GROUP_PREFIX}${name}`,
      value: members.join(","),
      from: "store",
      scope: "store",
    })),
  ]
}
