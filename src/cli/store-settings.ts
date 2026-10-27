import { existsSync } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { DEFAULT_PHONE_COUNTRIES, parsePhoneCountries } from "../domain/phones.js"
import {
  DEFAULT_TASK_CATEGORIES,
  type TaskCategory,
  taskCategoryValue,
  unlistedNote,
  withTaskCategory,
} from "../domain/task-categories.js"
import type { AppIdentity } from "../ports/app.js"
import { typedCommand } from "../runs/scope.js"
import { ACCOUNT_GROUPS_SETTING, type AccountGroups, groupMembers, groupName } from "../search/account-list.js"
import { DEFAULT_STEMMERS, parseStemmers, type Stemmers } from "../search/stem.js"
import { openCache } from "../store/open.js"
import { storePath } from "../store/path.js"
import {
  applyTaskCategoryEdits,
  editsFrom,
  readTaskCategoryEdits,
  sharedConfigPath,
  writeTaskCategoryEdits,
} from "../store/shared-config.js"
import {
  accountGroupsOf,
  DEFAULT_AGENT_CLOSE,
  DEFAULT_FIRST_PASS_PER_CHAT,
  firstPassPerChatOf,
  openStore,
  savedAgentClose,
  savedFirstPassPerChat,
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
const AGENT_CLOSE = "task_agent_close"
const AGENT_CLOSE_MIN = "task_agent_close_min"
const FIRST_PASS = "task_first_pass_per_chat"

/** Settings of the store file, not of a profile: the store is one file for every profile, tg and MAX. */
export const STORE_SETTINGS = [
  ...Object.keys(SCRIPTS),
  PHONE_COUNTRIES,
  `${CATEGORY_PREFIX}<name>`,
  AGENT_CLOSE,
  AGENT_CLOSE_MIN,
  FIRST_PASS,
]

const GROUP_PREFIX = `${ACCOUNT_GROUPS_SETTING}.`

/**
 * The store settings a CLI offers. Phone countries, task rules and account groups belong to messages; a CLI that is
 * not a messenger would change them for tg and MAX without reading them itself.
 */
export const storeSettingsOf = (app: Pick<AppIdentity, "messenger">): string[] =>
  app.messenger === false ? Object.keys(SCRIPTS) : [...STORE_SETTINGS, `${GROUP_PREFIX}<name>`]

export const offersStoreSetting = (app: Pick<AppIdentity, "messenger">, setting: string): boolean =>
  app.messenger !== false || setting in SCRIPTS

export const isStoreSetting = (setting: string): boolean =>
  setting in SCRIPTS ||
  setting === PHONE_COUNTRIES ||
  setting === TASK_CATEGORIES ||
  setting.startsWith(CATEGORY_PREFIX) ||
  setting === AGENT_CLOSE ||
  setting === AGENT_CLOSE_MIN ||
  setting === FIRST_PASS ||
  setting.startsWith(GROUP_PREFIX)

export const changeStoreSetting = async (
  app: AppIdentity,
  env: NodeJS.ProcessEnv,
  setting: string,
  value: string | undefined,
) => {
  if (setting.startsWith(GROUP_PREFIX)) return changeGroup(app, env, setting, value)
  if (setting === PHONE_COUNTRIES) return changePhoneCountries(app, env, value)
  if (setting === TASK_CATEGORIES || setting.startsWith(CATEGORY_PREFIX))
    return changeCategory(app, env, setting, value)
  if (setting === AGENT_CLOSE || setting === AGENT_CLOSE_MIN) return changeAgentClose(env, setting, value)
  if (setting === FIRST_PASS) return changeFirstPass(app, env, value)
  const script = SCRIPTS[setting] as keyof Stemmers
  const store = await openStore({ env })
  try {
    const current = (await store.searchIndex.stemmers()) ?? DEFAULT_STEMMERS
    const next = parseStemmers({ ...current, [script]: value ?? DEFAULT_STEMMERS[script] })
    await store.searchIndex.saveStemmers(next)
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
      `found keep their old reading until \`${typedCommand(app.command, "mentions rebuild phone")}\``,
    rebuild: true,
  }
}

/** Category edits live in the shared config file; a list an older build saved in the store moves there first. */
const changeCategory = async (app: AppIdentity, env: NodeJS.ProcessEnv, setting: string, value: string | undefined) => {
  const store = await openStore({ env })
  const file = sharedConfigPath(storePath(env), env)
  try {
    const legacy = await store.tasks.savedCategories()
    const edits = { ...(legacy ? editsFrom(legacy) : {}), ...readTaskCategoryEdits(file) }
    if (setting === TASK_CATEGORIES) {
      if (value !== undefined)
        throw new CliError(
          "validation_error",
          `set one category at a time: config set ${CATEGORY_PREFIX}<name> "<meaning> | <words>"; ` +
            `config unset ${TASK_CATEGORIES} goes back to the default list`,
        )
      writeTaskCategoryEdits(file, undefined)
      if (legacy) await store.tasks.saveCategories(undefined)
      const unlisted = unlistedNote(await store.tasks.unlistedCategories(), app.command)
      return {
        result: {
          store: storePath(env),
          file,
          scope: "shared",
          setting,
          value: DEFAULT_TASK_CATEGORIES.map(({ name }) => name),
        },
        note: [
          `the default task categories again (${TASK_CATEGORIES} removed from ${file}); tasks keep the category they have`,
          ...unlisted,
        ].join("\n"),
      }
    }
    const name = setting.slice(CATEGORY_PREFIX.length).trim().toLowerCase()
    const next = withTaskCategory(await store.tasks.categories(), name, value)
    const set = next.find((one) => one.name === name)
    if (set) edits[name] = taskCategoryValue(set)
    else if (DEFAULT_TASK_CATEGORIES.some((one) => one.name === name)) edits[name] = null
    else delete edits[name]
    writeTaskCategoryEdits(file, edits)
    if (legacy) await store.tasks.saveCategories(undefined)
    const unlisted = unlistedNote(await store.tasks.unlistedCategories(), app.command)
    return {
      result: { store: storePath(env), file, scope: "shared", setting, value: set ? taskCategoryValue(set) : null },
      note: [
        `saved in ${file} — rules, tasks add and tasks update in tg, MAX and memo take categories from it; ` +
          "tasks keep the category they have",
        ...unlisted,
      ].join("\n"),
    }
  } finally {
    await store.close()
  }
}

const changeFirstPass = async (app: AppIdentity, env: NodeJS.ProcessEnv, value: string | undefined) => {
  const n = value === undefined ? null : firstPassPerChatOf(value, FIRST_PASS)
  const store = await openStore({ env })
  try {
    await store.tasks.saveFirstPassPerChat(n)
    const now = await store.tasks.firstPassPerChat()
    return {
      result: { store: storePath(env), scope: "store", setting: FIRST_PASS, value: now },
      note:
        `store-wide — an account's first sync opens at most ${now} task(s) per chat from history; later syncs read ` +
        `only new messages. \`${typedCommand(app.command, "tasks scan <chat>")}\` builds tasks from a chat's history when asked`,
    }
  } finally {
    await store.close()
  }
}

const changeAgentClose = async (env: NodeJS.ProcessEnv, setting: string, value: string | undefined) => {
  const typed = value?.trim().toLowerCase()
  let change: { allowed?: boolean | null; min?: number | null }
  if (setting === AGENT_CLOSE) {
    if (typed !== undefined && typed !== "on" && typed !== "off")
      throw new CliError("validation_error", `${AGENT_CLOSE} takes on or off — not "${value}"`)
    change = { allowed: typed === undefined ? null : typed === "on" }
  } else {
    const min = typed === undefined ? null : Number(typed)
    if (min !== null && (typed === "" || !Number.isFinite(min) || min < 0 || min > 1))
      throw new CliError("validation_error", `${AGENT_CLOSE_MIN} takes a number from 0 to 1 — not "${value}"`)
    change = { min }
  }
  const store = await openStore({ env })
  try {
    await store.tasks.saveAgentClose(change)
    const now = await store.tasks.agentClose()
    return {
      result: {
        store: storePath(env),
        scope: "store",
        setting,
        value: setting === AGENT_CLOSE ? (now.allowed ? "on" : "off") : now.min,
      },
      note:
        "store-wide — an agent's tasks close in tg, MAX and memo closes the task when agent closes are on and its " +
        `certainty is at least ${now.min}; otherwise the close waits on the owner. Agent closes are ${now.allowed ? "on" : "off"}`,
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
    await store.accounts.saveAccountGroup(name, members)
    return {
      result: { store: storePath(env), scope: "store", setting, value: members ?? null },
      note:
        `store-wide — \`--source group:${name}\` searches these accounts from every app; ` +
        `a profile is found once its app has saved something (\`${typedCommand(app.command, "config show")}\`)`,
    }
  } finally {
    await store.close()
  }
}

/** Each category as `config show` lists it, and where it comes from: the shared file, an older store's list, the default. */
const categoryRows = (saved: readonly TaskCategory[] | undefined, file: string) => {
  let edits: ReturnType<typeof readTaskCategoryEdits>
  try {
    edits = readTaskCategoryEdits(file)
  } catch (error) {
    return [
      {
        setting: TASK_CATEGORIES,
        value: null,
        from: `${file} unreadable: ${(error as Error).message}`,
        scope: "shared",
      },
    ]
  }
  const base = saved ?? DEFAULT_TASK_CATEGORIES
  const list = edits ? applyTaskCategoryEdits(base, edits, file) : base
  return list.map((category) => ({
    setting: `${CATEGORY_PREFIX}${category.name}`,
    value: taskCategoryValue(category),
    from: edits && category.name in edits ? file : saved ? "store" : "default",
    scope: "shared",
  }))
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
  let agentClose: ReturnType<typeof savedAgentClose> = {}
  let firstPass: number | undefined
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
        agentClose = table ? savedAgentClose(database) : {}
        firstPass = table ? savedFirstPassPerChat(database) : undefined
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
    ...(unreadable ? [] : categoryRows(categories, sharedConfigPath(path, env))),
    ...(unreadable
      ? []
      : [
          {
            setting: AGENT_CLOSE,
            value: (agentClose.allowed ?? DEFAULT_AGENT_CLOSE.allowed) ? "on" : "off",
            from: agentClose.allowed === undefined ? "default" : "store",
            scope: "store",
          },
          {
            setting: AGENT_CLOSE_MIN,
            value: agentClose.min ?? DEFAULT_AGENT_CLOSE.min,
            from: agentClose.min === undefined ? "default" : "store",
            scope: "store",
          },
          {
            setting: FIRST_PASS,
            value: firstPass ?? DEFAULT_FIRST_PASS_PER_CHAT,
            from: firstPass === undefined ? "default" : "store",
            scope: "store",
          },
        ]),
    ...Object.entries(groups).map(([name, members]) => ({
      setting: `${GROUP_PREFIX}${name}`,
      value: members.join(","),
      from: "store",
      scope: "store",
    })),
  ]
}
