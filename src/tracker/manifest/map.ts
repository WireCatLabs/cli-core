import { crmValues } from "../../crm/index.js"
import type { CrmRule } from "../../crm/manifest/manifest.js"
import type { Conversion } from "../../crm/manifest/map.js"
import { convert, mapFields, rulePaths } from "../../crm/manifest/map.js"
import { STATE_TYPES, type TrackerKind, type TrackerRecords } from "../../domain/tracker.js"

const TIMES = {
  externalId: "id",
  createdAt: "epoch",
  updatedAt: "epoch",
  archivedAt: "epoch",
  deleted: "bool",
} as const
// A literal after `key:` reads as a permission key to src/cli/permission-keys.test.ts.
const KEY: Conversion = "text"

/** Each of our fields and how a value the tracker sent becomes it. */
export const TRACKER_FIELDS: { readonly [K in TrackerKind]: Readonly<Record<string, Conversion>> } = {
  team: { ...TIMES, name: "text", key: KEY },
  user: { ...TIMES, name: "text", email: "text", active: "bool" },
  state: { ...TIMES, name: "text", type: "text", team: "id", position: "number" },
  label: { ...TIMES, name: "text", team: "id" },
  project: {
    ...TIMES,
    name: "text",
    description: "text",
    status: "text",
    lead: "id",
    teams: "ids",
    targetDate: "day",
    url: "text",
  },
  sprint: {
    ...TIMES,
    name: "text",
    number: "number",
    description: "text",
    team: "id",
    startsAt: "epoch",
    endsAt: "epoch",
    completedAt: "epoch",
  },
  issue: {
    ...TIMES,
    title: "text",
    key: KEY,
    description: "text",
    state: "id",
    team: "id",
    project: "id",
    sprint: "id",
    assignee: "id",
    creator: "id",
    labels: "ids",
    parent: "id",
    priority: "number",
    dueDate: "day",
    completedAt: "epoch",
    canceledAt: "epoch",
    url: "text",
  },
  comment: { ...TIMES, issue: "id", body: "text", author: "id", url: "text" },
}

/** The fields a record of the kind always has; a missing one gets its empty value, never a guess. */
const REQUIRED: { readonly [K in TrackerKind]: Readonly<Record<string, unknown>> } = {
  team: { name: "" },
  user: { name: "" },
  state: { name: "" },
  label: { name: "" },
  project: { name: "" },
  sprint: { name: "" },
  issue: { title: "" },
  comment: { body: "" },
}

/** A selected object the tracker answered null (`project: null`): the field is none, not "not sent". */
const nulled = (raw: crmValues.CrmRaw, path: string): boolean => {
  let inner: unknown = raw
  for (const step of path.split(".")) {
    if (inner === null) return true
    if (!crmValues.isRaw(inner)) return false
    inner = inner[step]
  }
  return false
}

/** One row as our record of the kind, or null for a row without an id, or a state whose type is none of ours. */
export const mapTrackerRecord = <K extends TrackerKind>(
  kind: K,
  map: Readonly<Record<string, CrmRule | undefined>>,
  raw: crmValues.CrmRaw,
): TrackerRecords[K] | null => {
  const out = mapFields(map, TRACKER_FIELDS[kind], raw)
  for (const [field, rule] of Object.entries(map)) {
    const type = TRACKER_FIELDS[kind][field]
    if (out[field] !== undefined || type === undefined) continue
    if (rulePaths(rule).some(({ path, inside }) => inside === undefined && nulled(raw, path)))
      out[field] = convert(type, null)
  }
  if (typeof out.externalId !== "string") return null
  for (const [field, empty] of Object.entries(REQUIRED[kind])) if (out[field] == null) out[field] = empty
  // "Open work" is read by the type, so a state of an unknown type would hide its issues from every filter.
  if (kind === "state" && !(STATE_TYPES as readonly unknown[]).includes(out.type)) return null
  if (kind === "comment" && typeof out.issue !== "string") return null
  return out as unknown as TrackerRecords[K]
}
