import { CliError } from "@wirecat/cli-base"
import { type CrmScopeSetting, isCrmUserId, normalCrmUserId } from "../../domain/crm.js"
import type { DealKind } from "../../domain/deals.js"
import type { CacheDatabase } from "../driver.js"
import type { AccountKey } from "../types.js"

/** `reported`: what a CRM account says is a relationship nobody confirmed; `review`: it waits as a proposal. */
export const CRM_LINK_MODES = ["reported", "review"] as const
export type CrmLinkMode = (typeof CRM_LINK_MODES)[number]

/** What a CRM company type may mean: the company buys from the own company, sells to it, or partners with it. */
export const COMPANY_TYPE_MEANINGS = ["customer-of", "supplier", "partner-of"] as const
export type CompanyTypeMeaning = (typeof COMPANY_TYPE_MEANINGS)[number]

/** `mine`: only the deals and leads of the sign-in's own user and of the `unassigned` users; `all`: every one. */
export const CRM_SCOPES = ["mine", "all"] as const

/** `activities`: whether a sync also reads the activities and tasks on the deals and leads it keeps; off by default. */
export const CRM_ACTIVITIES = ["on", "off"] as const

const NAMES = ["links", "company-types", "scope", "unassigned", "self", "stage-tasks", "activities"] as const
type CrmSettingName = (typeof NAMES)[number]
const SETTING = new RegExp(`^crm\\.([a-z0-9-]+):(.+)\\.(${NAMES.join("|")})$`)

export const crmSettingKey = (key: AccountKey, name: CrmSettingName): string =>
  `crm.${key.provider}:${key.account}.${name}`

/** The account and the setting a key names; a portal's account may hold dots, so it is read from both ends. */
export const parseCrmSetting = (setting: string): { key: AccountKey; name: CrmSettingName } | undefined => {
  const match = SETTING.exec(setting)
  return match
    ? { key: { provider: match[1] as string, account: match[2] as string }, name: match[3] as CrmSettingName }
    : undefined
}

const stored = (database: CacheDatabase, setting: string): unknown => {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(setting)
  if (!row) return undefined
  try {
    return JSON.parse(String(row.value))
  } catch {
    return undefined
  }
}

/** A value this build cannot read is the default: the CRM's relationships stay reported. */
export const crmLinkMode = (database: CacheDatabase, key: AccountKey): CrmLinkMode => {
  const value = stored(database, crmSettingKey(key, "links"))
  return value === "review" ? "review" : "reported"
}

/** Activities and tasks hold what clients wrote and said: read only once the owner turns them on. */
export const crmActivitiesOn = (database: CacheDatabase, key: AccountKey): boolean =>
  stored(database, crmSettingKey(key, "activities")) === "on"

/** Only the owner's mapping gives a company type a meaning; none by default. */
export const crmCompanyTypes = (database: CacheDatabase, key: AccountKey): Record<string, CompanyTypeMeaning> => {
  const value = stored(database, crmSettingKey(key, "company-types"))
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, CompanyTypeMeaning] =>
      (COMPANY_TYPE_MEANINGS as readonly unknown[]).includes(entry[1]),
    ),
  )
}

/** Kept as stored, a malformed one too: the sync refuses it by name rather than copy fewer deals without a word. */
const userIds = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : []

/** `mine` unless the owner chose `all`: a sync never copies other people's deals without being asked. */
export const crmScope = (database: CacheDatabase, key: AccountKey): CrmScopeSetting => {
  const scope = stored(database, crmSettingKey(key, "scope"))
  if (scope === "all") return { mode: "all" }
  return { mode: "mine", also: userIds(stored(database, crmSettingKey(key, "unassigned"))), explicit: scope === "mine" }
}

const picked = (name: string, text: string, values: readonly string[]) => {
  if (!values.includes(text))
    throw new CliError("validation_error", `a CRM account's ${name} setting is ${values.join(" or ")}`)
  return text
}

/** The users whose deals and leads scope mine keeps, whatever the scope is now: `self` and the `unassigned` list. */
export const crmScopeUsers = (database: CacheDatabase, key: AccountKey): string[] => {
  const self = crmOwnUser(database, key)
  return [...new Set([...(self ? [self] : []), ...userIds(stored(database, crmSettingKey(key, "unassigned")))])]
}

/**
 * `links`: reported or review; `scope`: mine or all; `unassigned`: the CRM's user ids, comma-separated;
 * `company-types`: `TYPE=meaning` pairs, comma-separated.
 */
/** The CRM user whose deals the account's copy holds: the first sync's sign-in, until the owner unsets it. */
export const crmOwnUser = (database: CacheDatabase, key: AccountKey): string | undefined => {
  const value = stored(database, crmSettingKey(key, "self"))
  return typeof value === "string" && value ? value : undefined
}

/** What a deal or lead entering the stage opens: a task of this title, due this many days later. */
export interface StageTaskRule {
  title: string
  dueDays: number
}
export type CrmStageTasks = Record<DealKind, Record<string, StageTaskRule>>

const STAGE_TASK_FIELDS = ["title", "due_days"]
const MAX_DUE_DAYS = 3650

const stageTaskRule = (value: unknown): StageTaskRule | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const { title, due_days: dueDays } = value as Record<string, unknown>
  if (Object.keys(value).some((field) => !STAGE_TASK_FIELDS.includes(field))) return undefined
  if (typeof title !== "string" || !title.trim() || title.trim().length > 300) return undefined
  if (!Number.isSafeInteger(dueDays) || (dueDays as number) < 0 || (dueDays as number) > MAX_DUE_DAYS) return undefined
  return { title: title.trim(), dueDays: dueDays as number }
}

/** A bare stage id is a deal's, as most CRMs name deal stages; `lead:<stage>` is a lead's, whose ids may be the same. */
const stageOf = (stage: string): [DealKind, string] =>
  stage.startsWith("lead:") ? ["lead", stage.slice(5)] : ["deal", stage.startsWith("deal:") ? stage.slice(5) : stage]

/** Only the owner's rules open a task on a stage change; an entry this build cannot read opens none. */
export const crmStageTasks = (database: CacheDatabase, key: AccountKey): CrmStageTasks => {
  const value = stored(database, crmSettingKey(key, "stage-tasks"))
  const rules: CrmStageTasks = { deal: {}, lead: {} }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return rules
  for (const [stage, entry] of Object.entries(value)) {
    const rule = stageTaskRule(entry)
    const [kind, id] = stageOf(stage)
    if (rule && id) rules[kind][id] = rule
  }
  return rules
}

const parseStageTasks = (text: string): Record<string, { title: string; due_days: number }> => {
  const refuse = (why: string): never => {
    throw new CliError(
      "validation_error",
      `stage-tasks takes JSON: {"<stage id>": {"title": "<task title>", "due_days": <days>}}, a lead's stage as ` +
        `"lead:<stage id>": ${why}`,
    )
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return refuse("not JSON")
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return refuse("not an object")
  const rules: Record<string, { title: string; due_days: number }> = {}
  for (const [stage, entry] of Object.entries(value)) {
    const rule = stageTaskRule(entry)
    if (!stageOf(stage.trim())[1]) return refuse(`"${stage}" names no stage`)
    if (!rule)
      return refuse(
        `the rule of "${stage}" needs a title of up to 300 characters and due_days from 0 to ${MAX_DUE_DAYS}, nothing else`,
      )
    rules[stage.trim()] = { title: rule.title, due_days: rule.dueDays }
  }
  return rules
}

/** The last stage change the account's stage tasks have seen; not a setting, so `config` never lists it. */
const stageTasksMark = (setting: string): string => `${setting}.after`

/** After the mark, oldest first: each stage a deal or lead of the account entered from another one, and the newest id read. */
export const crmStageMoves = (
  database: CacheDatabase,
  key: AccountKey,
  accountId: number | undefined,
): { moves: CrmStageMove[]; through: number } => {
  const through = Number(database.prepare("SELECT coalesce(max(id), 0) AS id FROM pipeline_stage_changes").get()?.id)
  const mark = stored(database, stageTasksMark(crmSettingKey(key, "stage-tasks")))
  // With no mark, every move so far happened before the rules: none of them opens a task.
  if (typeof mark !== "number" || accountId === undefined) return { moves: [], through }
  const moves = database
    .prepare(
      "SELECT c.id, c.item_type, c.item_id, s.external_id AS stage, s.name AS stage_name, p.name AS pipeline_name " +
        "FROM pipeline_stage_changes c JOIN pipeline_stages s ON s.id = c.to_stage_id " +
        "JOIN pipelines p ON p.id = c.pipeline_id " +
        "LEFT JOIN deals d ON c.item_type = 'deal' AND d.id = c.item_id " +
        "LEFT JOIN leads l ON c.item_type = 'lead' AND l.id = c.item_id " +
        "WHERE c.id > ? AND c.id <= ? AND c.from_stage_id IS NOT NULL AND s.external_id IS NOT NULL " +
        "AND coalesce(d.account_id, l.account_id) = ? AND coalesce(d.deleted_at, l.deleted_at) IS NULL ORDER BY c.id",
    )
    .all(mark, through, accountId)
    .map((row) => ({
      id: Number(row.id),
      kind: row.item_type as DealKind,
      ref: `${String(row.item_type)}:${String(row.item_id)}`,
      stage: String(row.stage),
      stageName: String(row.stage_name),
      pipelineName: String(row.pipeline_name),
    }))
  return { moves, through }
}

export interface CrmStageMove {
  /** The stage change's own id: one task per entry into a stage, never two. */
  id: number
  kind: DealKind
  ref: string
  /** The CRM's id of the stage entered. */
  stage: string
  stageName: string
  pipelineName: string
}

export const saveStageMovesMark = (database: CacheDatabase, key: AccountKey, through: number, now: number): void => {
  database
    .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
    .run(stageTasksMark(crmSettingKey(key, "stage-tasks")), JSON.stringify(through), now)
}

export const parseCrmSettingValue = (name: CrmSettingName, value: string): unknown => {
  const text = value.trim()
  if (name === "stage-tasks") return parseStageTasks(text)
  if (name === "links") return picked(name, text, CRM_LINK_MODES)
  if (name === "scope") return picked(name, text, CRM_SCOPES)
  if (name === "activities") return picked(name, text, CRM_ACTIVITIES)
  if (name === "self") {
    if (!isCrmUserId(text))
      throw new CliError("validation_error", `self takes the CRM's numeric user id: not "${text}"`)
    return normalCrmUserId(text)
  }
  if (name === "unassigned") {
    const ids = [...new Set(text.split(",").map((one) => one.trim()))]
    const bad = ids.find((one) => !isCrmUserId(one))
    if (bad !== undefined)
      throw new CliError(
        "validation_error",
        `unassigned takes the CRM's numeric user ids, comma-separated: not "${bad}"`,
      )
    return ids
  }
  const pairs = text
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
  const map: Record<string, CompanyTypeMeaning> = {}
  for (const pair of pairs) {
    const [type, meaning] = pair.split("=").map((part) => part.trim())
    if (!type || !(COMPANY_TYPE_MEANINGS as readonly string[]).includes(meaning ?? ""))
      throw new CliError(
        "validation_error",
        `company-types takes TYPE=meaning pairs, the meaning ${COMPANY_TYPE_MEANINGS.join(", ")}: not "${pair}"`,
      )
    map[type] = meaning as CompanyTypeMeaning
  }
  return map
}

export const saveCrmSetting = (database: CacheDatabase, setting: string, value: unknown, now: number): void => {
  if (value === undefined) database.prepare("DELETE FROM store_settings WHERE key = ?").run(setting)
  else
    database
      .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
      .run(setting, JSON.stringify(value), now)
  if (parseCrmSetting(setting)?.name !== "stage-tasks") return
  const mark = stageTasksMark(setting)
  // Rules apply from the moment they are first set: moves made before, however many, open no task.
  if (value === undefined) database.prepare("DELETE FROM store_settings WHERE key = ?").run(mark)
  else
    database
      .prepare(
        "INSERT OR IGNORE INTO store_settings (key, value, at) " +
          "SELECT ?, coalesce(max(id), 0), ? FROM pipeline_stage_changes",
      )
      .run(mark, now)
}

const settingValue = (database: CacheDatabase, key: AccountKey, name: CrmSettingName): unknown => {
  if (name === "links") return crmLinkMode(database, key)
  if (name === "company-types") return crmCompanyTypes(database, key)
  if (name === "scope") return crmScope(database, key).mode
  if (name === "self") return crmOwnUser(database, key) ?? null
  if (name === "stage-tasks") return stored(database, crmSettingKey(key, name)) ?? {}
  if (name === "activities") return crmActivitiesOn(database, key) ? "on" : "off"
  return userIds(stored(database, crmSettingKey(key, name)))
}

export const crmSettingsOf = (database: CacheDatabase): { setting: string; value: unknown }[] =>
  database
    .prepare("SELECT key, value FROM store_settings WHERE key LIKE 'crm.%' ORDER BY key")
    .all()
    .flatMap((row) => {
      const parsed = parseCrmSetting(String(row.key))
      if (!parsed) return []
      return [{ setting: String(row.key), value: settingValue(database, parsed.key, parsed.name) }]
    })
