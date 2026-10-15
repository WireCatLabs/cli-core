import { existsSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { DEFAULT_PHONE_COUNTRIES, parsePhoneCountries } from "../domain/phones.js"
import {
  DEFAULT_TASK_CATEGORIES,
  type TaskCategory,
  taskCategoryValue,
  withTaskCategory,
} from "../domain/task-categories.js"
import type { AppIdentity } from "../ports/app.js"
import { ACCOUNT_GROUPS_SETTING, type AccountGroups, groupMembers, groupName } from "../search/account-list.js"
import { DEFAULT_STEMMERS, parseStemmers, type Stemmers } from "../search/stem.js"
import { openCache } from "../store/open.js"
import { storePath } from "../store/path.js"
import {
  accountGroupsOf,
  openStore,
  savedPhoneCountries,
  savedStemmers,
  savedTaskCategories,
  saveStorePhoneCountries,
  stemmersOrigin,
} from "../store/store.js"

const SCRIPTS: Record<string, keyof Stemmers> = {
  "search_stemmers.cyrillic": "cyrillic",
  "search_stemmers.latin": "latin",
}

const PHONE_COUNTRIES = "phone_countries"
const TASK_CATEGORIES = "task_categories"
const CATEGORY_PREFIX = `${TASK_CATEGORIES}.`

/** Settings of the store file, not of a profile: the store is one file for every profile, tg and MAX. */
export const STORE_SETTINGS = [...Object.keys(SCRIPTS), PHONE_COUNTRIES, `${CATEGORY_PREFIX}<name>`]

const GROUP_PREFIX = `${ACCOUNT_GROUPS_SETTING}.`

export const isStoreSetting = (setting: string): boolean =>
  setting in SCRIPTS ||
  setting === PHONE_COUNTRIES ||
  setting === TASK_CATEGORIES ||
  setting.startsWith(CATEGORY_PREFIX) ||
  setting.startsWith(GROUP_PREFIX)

export const changeStoreSetting = async (
  app: AppIdentity,
  env: NodeJS.ProcessEnv,
  setting: string,
  value: string | undefined,
) => {
  if (setting.startsWith(GROUP_PREFIX)) return changeGroup(app, env, setting, value)
  if (setting === PHONE_COUNTRIES) return changePhoneCountries(app, env, value)
  if (setting === TASK_CATEGORIES || setting.startsWith(CATEGORY_PREFIX)) return changeCategory(env, setting, value)
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

const changePhoneCountries = async (app: AppIdentity, env: NodeJS.ProcessEnv, value: string | undefined) => {
  const countries = value === undefined ? undefined : parsePhoneCountries(value)
  // Opened as a store first, so a new or older file gets its tables before the setting is written.
  await (await openStore({ env })).close()
  const database = await openCache(storePath(env))
  try {
    saveStorePhoneCountries(database, countries, Date.now())
  } finally {
    database.close()
  }
  return {
    result: {
      store: storePath(env),
      scope: "store",
      setting: PHONE_COUNTRIES,
      value: (countries ?? DEFAULT_PHONE_COUNTRIES).join(","),
    },
    note:
      "store-wide — a number written without + is read in these countries, the first that fits; numbers already " +
      `found keep their old reading until \`${app.command} mentions rebuild phone\``,
    rebuild: true,
  }
}

const changeCategory = async (env: NodeJS.ProcessEnv, setting: string, value: string | undefined) => {
  const store = await openStore({ env })
  try {
    if (setting === TASK_CATEGORIES) {
      if (value !== undefined)
        throw new CliError(
          "validation_error",
          `set one category at a time: config set ${CATEGORY_PREFIX}<name> "<meaning> | <words>"; ` +
            `config unset ${TASK_CATEGORIES} goes back to the default list`,
        )
      await store.tasks.saveCategories(undefined)
      return {
        result: {
          store: storePath(env),
          scope: "store",
          setting,
          value: DEFAULT_TASK_CATEGORIES.map(({ name }) => name),
        },
        note: "store-wide — the default task categories again; tasks keep the category they have",
      }
    }
    const name = setting.slice(CATEGORY_PREFIX.length)
    const next = withTaskCategory(await store.tasks.categories(), name, value)
    await store.tasks.saveCategories(next)
    const set = next.find((one) => one.name === name.trim().toLowerCase())
    return {
      result: { store: storePath(env), scope: "store", setting, value: set ? taskCategoryValue(set) : null },
      note:
        "store-wide — rules, tasks add and tasks plan in tg, MAX and memo take categories from this list; " +
        "tasks keep the category they have",
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
  let phoneCountries: string[] | undefined
  let categories: TaskCategory[] | undefined
  if (existsSync(path)) {
    try {
      const database = await openCache(path)
      try {
        const table = database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'store_settings'").get()
        saved = table ? savedStemmers(database) : undefined
        byDefault = table ? stemmersOrigin(database)?.origin === "default" : false
        groups = table ? accountGroupsOf(database) : {}
        phoneCountries = table ? savedPhoneCountries(database) : undefined
        categories = table ? savedTaskCategories(database) : undefined
      } finally {
        database.close()
      }
    } catch {
      unreadable = true
    }
  }
  const stemmers = Object.keys(SCRIPTS).map((setting) => {
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
    unreadable
      ? { setting: PHONE_COUNTRIES, value: null, from: "store unreadable", scope: "store" }
      : {
          setting: PHONE_COUNTRIES,
          value: (phoneCountries ?? DEFAULT_PHONE_COUNTRIES).join(","),
          from: phoneCountries ? "store" : "default",
          scope: "store",
        },
    ...(unreadable ? [] : (categories ?? DEFAULT_TASK_CATEGORIES)).map((category) => ({
      setting: `${CATEGORY_PREFIX}${category.name}`,
      value: taskCategoryValue(category),
      from: categories ? "store" : "default",
      scope: "store",
    })),
    ...Object.entries(groups).map(([name, members]) => ({
      setting: `${GROUP_PREFIX}${name}`,
      value: members.join(","),
      from: "store",
      scope: "store",
    })),
  ]
}
