import { isEngagement } from "../../domain/relations.js"
import type { CacheDatabase } from "../driver.js"
import { sourceOf } from "./link-source.js"
import type { Link } from "./notes.js"
import { referenceOfThing, storedThing } from "./things.js"

type Row = Record<string, unknown>
const iso = (value: unknown) => new Date(Number(value)).toISOString()

export const thingRef = (database: CacheDatabase, type: unknown, id: unknown): string | null =>
  type == null || id == null ? null : (referenceOfThing(database, storedThing(type, id)) ?? null)

// A chat or meeting deleted since leaves its links behind with no end to name.
export const hasBothEnds = (link: Link): boolean => link.from !== null && link.to !== null

export const linkOf = (database: CacheDatabase, row: Row): Link => {
  const metadata: Partial<Record<string, unknown>> = row.metadata == null ? {} : JSON.parse(String(row.metadata))
  // An older row holds one word; every reader gets a list.
  const sourceRoles = [metadata.source_role].flat().filter((word): word is string => typeof word === "string")
  return {
    id: String(row.id),
    from: thingRef(database, row.from_type, row.from_id) as string,
    to: thingRef(database, row.to_type, row.to_id),
    kind: row.kind as Link["kind"],
    anchor: row.anchor == null ? null : String(row.anchor),
    origin: row.source as Link["origin"],
    targetText: row.target_text == null ? null : String(row.target_text),
    role: row.role == null ? null : String(row.role),
    purpose: row.purpose == null ? null : String(row.purpose),
    evidence: row.evidence == null ? null : String(row.evidence),
    provenance: typeof metadata.provenance === "string" ? metadata.provenance : null,
    confirmed: Number(row.confirmed) === 1,
    createdAt: iso(row.created_at),
    ...(row.account_id == null ? {} : { accountId: Number(row.account_id) }),
    ...(row.starts_at == null ? {} : { startsAt: Number(row.starts_at) }),
    ...(row.ends_at == null ? {} : { endsAt: Number(row.ends_at) }),
    ...(row.deleted_at == null ? {} : { deletedAt: Number(row.deleted_at) }),
    ...(typeof metadata.position === "string" ? { position: metadata.position } : {}),
    ...(typeof metadata.roleNote === "string" ? { roleNote: metadata.roleNote } : {}),
    ...(isEngagement(metadata.engagement) ? { engagement: metadata.engagement } : {}),
    ...(typeof metadata.overrides === "number" ? { overrides: metadata.overrides } : {}),
    ...(sourceRoles.length ? { sourceRoles } : {}),
    ...sourceOf(database, row, metadata),
  }
}
