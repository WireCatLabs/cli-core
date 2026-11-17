import type { CrmField, CrmKind, CrmRecords } from "../../domain/crm.js"
import { DEAL_STATUSES } from "../../domain/deals.js"
import { amountOf, type CrmRaw, crmValuesOf, epoch, fullName, id, isRaw, text } from "../values.js"
import type { CrmRule } from "./manifest.js"

/** The service sent nothing at this path: the field is left out, so the stored copy keeps what it held. */
export const MISSING = Symbol("missing")
type Read = unknown | typeof MISSING

/** A dotted path; a number steps into a list (`results.0.id`), and `.` is the value itself. */
export const at = (value: unknown, path: string): unknown =>
  path === "."
    ? value
    : path.split(".").reduce<unknown>(
        (inner, key) =>
          // Past the end of a list the service sent is "none", not "not sent": a removed link must leave the copy.
          Array.isArray(inner) && /^\d+$/.test(key)
            ? (inner[Number(key)] ?? null)
            : isRaw(inner)
              ? inner[key]
              : undefined,
        value,
      )

const read = (raw: CrmRaw, path: string): Read => {
  const found = at(raw, path)
  return found === undefined ? MISSING : found
}

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === null ? [] : [value])

const reads = (raw: CrmRaw, paths: readonly string[]) => {
  const found = paths.map((path) => read(raw, path)).filter((one) => one !== MISSING)
  return found.length ? found : MISSING
}

export const evaluate = (rule: CrmRule, raw: CrmRaw): Read => {
  if (typeof rule === "string") return read(raw, rule)
  if (typeof rule === "function") {
    const found = rule(raw)
    return found === undefined ? MISSING : found
  }
  if ("value" in rule && !("each" in rule)) return rule.value
  if ("first" in rule) {
    const found = reads(raw, rule.first)
    return found === MISSING ? MISSING : (found.find((one) => text(one) !== null) ?? null)
  }
  if ("join" in rule) {
    const found = reads(raw, rule.join)
    return found === MISSING ? MISSING : fullName(...found)
  }
  if ("all" in rule) {
    const found = reads(raw, rule.all)
    if (found === MISSING) return MISSING
    return found.flatMap((one) => (rule.split && typeof one === "string" ? one.split(rule.split) : listOf(one)))
  }
  if ("each" in rule) {
    const found = read(raw, rule.each)
    if (found === MISSING) return MISSING
    if ("value" in rule) return listOf(found).map((one) => at(one, rule.value))
    const primary = rule.primary === undefined ? null : id(at(raw, rule.primary))
    return listOf(found).map((one) => ({ id: at(one, rule.id), primary }))
  }
  const found = read(raw, rule.path)
  if (found === MISSING) return MISSING
  if ("map" in rule) return Object.hasOwn(rule.map, String(found)) ? rule.map[String(found)] : null
  return rule.split && typeof found === "string" ? found.split(rule.split) : found
}

/** A time as epoch ms: ISO, epoch seconds, or epoch ms as digits in a string (HubSpot sends both forms). */
const epochOf = (value: unknown): number | null =>
  typeof value === "string" && /^\d{10,16}$/.test(value.trim()) ? epoch(Number(value)) : epoch(value)

/** The day as the service wrote it: a time with an offset turned into UTC may fall on the day before. */
const dayOf = (value: unknown): string | null => {
  const written = /^(\d{4}-\d{2}-\d{2})/.exec(typeof value === "string" ? value.trim() : "")?.[1]
  if (written) return written
  const ms = epochOf(value)
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10)
}

const unique = (values: readonly (string | null)[]) => [...new Set(values.filter((one): one is string => one !== null))]

const yes = (value: unknown): boolean => value === true || value === 1 || value === "1" || value === "true"

interface Linked {
  externalId: string
  primary: boolean
}

/** Links each once, the primary first: `primary` names it, else none is marked. */
const linksOf = (value: unknown): Linked[] => {
  const listed = listOf(value).map((one) =>
    isRaw(one) && "id" in one ? { id: id(one.id), primary: id(one.primary) } : { id: id(one), primary: null },
  )
  const ids = unique(listed.map((one) => one.id))
  const primary = listed.find((one) => one.primary !== null)?.primary ?? null
  const ordered = primary !== null && ids.includes(primary) ? [primary, ...ids.filter((one) => one !== primary)] : ids
  return ordered.map((externalId) => ({ externalId, primary: externalId === primary }))
}

const CONVERT = {
  id,
  text,
  epoch: epochOf,
  day: dayOf,
  bool: yes,
  texts: (value: unknown) => unique(listOf(value).map(text)),
  ids: (value: unknown) => linksOf(value).map(({ externalId }) => externalId),
  status: (value: unknown) => {
    const found = text(value)
    return (DEAL_STATUSES as readonly string[]).includes(found ?? "") ? found : null
  },
  organizations: (value: unknown) =>
    linksOf(value).map(({ externalId, primary }) => ({ externalId, ...(primary ? { primary } : {}) })),
  people: (value: unknown) =>
    linksOf(value).map(({ externalId, primary }) => ({
      externalId,
      role: "contact" as const,
      ...(primary ? { primary } : {}),
    })),
} satisfies Record<string, (value: unknown) => unknown>

export type Conversion = keyof typeof CONVERT

const TIMES = { createdAt: "epoch", updatedAt: "epoch" } as const

const ITEM = {
  externalId: "id",
  title: "text",
  pipeline: "text",
  stage: "text",
  status: "status",
  closeDate: "day",
  closedDate: "day",
  closedReason: "text",
  organization: "id",
  contactName: "text",
  companyName: "text",
  people: "people",
  deal: "id",
  url: "text",
  assignee: "id",
  ...TIMES,
} as const

/** Each of our fields and how a value the service sent becomes it. */
export const FIELDS: { readonly [K in CrmKind]: Readonly<Record<string, Conversion>> } = {
  person: {
    externalId: "id",
    name: "text",
    firstName: "text",
    lastName: "text",
    email: "text",
    phone: "text",
    emails: "texts",
    phones: "texts",
    position: "text",
    organizations: "organizations",
    assignee: "id",
    url: "text",
    ...TIMES,
  },
  organization: {
    externalId: "id",
    name: "text",
    url: "text",
    type: "text",
    own: "bool",
    phones: "texts",
    emails: "texts",
    people: "ids",
    assignee: "id",
    ...TIMES,
  },
  deal: ITEM,
  lead: ITEM,
}

/** The fields a record of the kind always has; a missing one gets its empty value, never a guess. */
const REQUIRED: { readonly [K in CrmKind]: Readonly<Record<string, unknown>> } = {
  person: { name: null },
  organization: { name: "" },
  deal: { title: "", pipeline: "", stage: "" },
  lead: { title: "", pipeline: "", stage: "" },
}

export const convert = (conversion: Conversion, value: unknown): unknown => CONVERT[conversion](value)

/** Our fields from the rules, each converted by `types`; a rule whose path is missing gives no key. */
export const mapFields = (
  rules: Readonly<Record<string, CrmRule | undefined>>,
  types: Readonly<Record<string, Conversion>>,
  raw: CrmRaw,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [field, rule] of Object.entries(rules)) {
    const type = types[field]
    if (rule === undefined || type === undefined) continue
    const found = evaluate(rule, raw)
    if (found !== MISSING) out[field] = convert(type, found)
  }
  return out
}

/** The account's own fields' values under `from`, labelled by their definitions. */
const customOf = (raw: CrmRaw, custom: { from: string; split?: string }, defined: readonly CrmField[]) => {
  const under = at(raw, custom.from)
  if (!isRaw(under)) return undefined
  const values: CrmRaw = {}
  for (const field of defined) {
    const value = under[field.code]
    if (value === null || value === undefined || value === "") continue
    values[field.code] = field.multiple && custom.split && typeof value === "string" ? value.split(custom.split) : value
  }
  return Object.keys(values).length ? crmValuesOf(values, defined) : undefined
}

export interface RecordRules {
  map: Readonly<Record<string, CrmRule | undefined>>
  custom?: { from: string; split?: string }
}

/** One row as our record of the kind, or null for a row without an id. */
export const mapRecord = <K extends CrmKind>(
  kind: K,
  rules: RecordRules,
  raw: CrmRaw,
  defined: readonly CrmField[] = [],
): CrmRecords[K] | null => {
  const out = mapFields(rules.map, FIELDS[kind], raw)
  if (typeof out.externalId !== "string") return null
  for (const [field, empty] of Object.entries(REQUIRED[kind])) if (out[field] == null) out[field] = empty ?? null
  if (kind === "person") {
    if (out.email === undefined && Array.isArray(out.emails)) out.email = out.emails[0] ?? null
    if (out.phone === undefined && Array.isArray(out.phones)) out.phone = out.phones[0] ?? null
  }
  if (rules.map.amount !== undefined || rules.map.currency !== undefined) {
    const amount = rules.map.amount === undefined ? MISSING : evaluate(rules.map.amount, raw)
    const currency = rules.map.currency === undefined ? MISSING : evaluate(rules.map.currency, raw)
    if (amount !== MISSING || currency !== MISSING)
      Object.assign(out, amountOf(amount === MISSING ? null : amount, currency === MISSING ? null : currency))
  }
  const metadata = rules.custom ? customOf(raw, rules.custom, defined) : undefined
  if (metadata) out.metadata = metadata
  return out as unknown as CrmRecords[K]
}

/** The names under `from` that the rules read: what a service that names its returned fields is asked for. */
export const selectedOf = (rules: Readonly<Record<string, CrmRule | undefined>>, from: string): string[] => {
  const prefix = `${from}.`
  const paths = Object.values(rules).flatMap((rule): string[] => {
    if (rule === undefined || typeof rule === "function") return []
    if (typeof rule === "string") return [rule]
    if ("first" in rule) return [...rule.first]
    if ("join" in rule) return [...rule.join]
    if ("all" in rule) return [...rule.all]
    if ("each" in rule) return [rule.each, ...("primary" in rule && rule.primary ? [rule.primary] : [])]
    return "path" in rule ? [rule.path] : []
  })
  return [
    ...new Set(
      paths.filter((one) => one.startsWith(prefix)).map((one) => one.slice(prefix.length).split(".")[0] ?? ""),
    ),
  ].filter(Boolean)
}
