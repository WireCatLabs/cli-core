import { CliError } from "@wirecat/cli-base"
import { checkRole, ROLE_LISTS, type RoleList, roleListOf } from "../../domain/relations.js"
import type { CacheDatabase } from "../driver.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

export interface RelationRole {
  id: string
  label: string | null
  builtIn: boolean
}

export interface RelationRoles {
  /** A list's roles: the built-in ones first, then the owner's, in the order he added them. */
  roles(list: RoleList): Promise<RelationRole[]>
  /** Adds an owner role to a list; an id the list holds already is refused. */
  addRole(list: RoleList, id: string, label?: string): Promise<RelationRole[]>
  /** Removes an owner role; a built-in one, or one a stored relationship still holds, is refused. */
  removeRole(list: RoleList, id: string): Promise<RelationRole[]>
}

const settingOf = (list: RoleList) => `relationships.roles.${list}`

const isList = (list: string): list is RoleList => Object.hasOwn(ROLE_LISTS, list)

const listOf = (list: string): RoleList => {
  if (!isList(list))
    throw new CliError("validation_error", `a role list is one of ${Object.keys(ROLE_LISTS).join(", ")}`)
  return list
}

/** The owner's roles for a list; a value this build cannot read is none. */
export const ownerRolesOf = (database: CacheDatabase, list: RoleList): { id: string; label: string | null }[] => {
  const row = database.prepare("SELECT value FROM store_settings WHERE key = ?").get(settingOf(list))
  try {
    const value = row ? (JSON.parse(String(row.value)) as unknown) : []
    return Array.isArray(value)
      ? value.flatMap((one) =>
          typeof one?.id === "string" ? [{ id: one.id, label: typeof one.label === "string" ? one.label : null }] : [],
        )
      : []
  } catch {
    return []
  }
}

/** The owner's role ids a relationship of these ends may also take. */
export const extraRolesOf = (database: CacheDatabase, kind: string, from: string, to: string): string[] => {
  const list = roleListOf(kind, from, to)
  return list ? ownerRolesOf(database, list).map(({ id }) => id) : []
}

/** `checkRole` with the owner's own roles for the list the ends take. */
export const checkStoredRole = (database: CacheDatabase, kind: string, from: string, to: string, role: string) =>
  checkRole(kind, from, to, role, extraRolesOf(database, kind, from, to))

/** The `related-to` links whose role comes from a list, by the types that name it. */
const RELATED_FROM: Partial<Record<RoleList, string>> = { deal: "'deal', 'lead'", contract: "'contract'" }

/**
 * The links whose role comes from this list: a person's on an organization or a project, a deal's or a lead's people,
 * a contract's parties.
 */
const usedBy = (database: CacheDatabase, list: RoleList, role: string): number => {
  const related = RELATED_FROM[list]
  const links = related
    ? `kind = 'related-to' AND from_type IN (${related})`
    : `kind = 'member-of' AND from_type = 'person' AND to_type = '${list}'`
  // A pending proposal would make the role a relationship's once approved: it counts as a use.
  const proposals = related
    ? `target_type IN (${related}) AND json_extract(payload, '$.kind') = 'related-to'`
    : `target_type = 'person' AND json_extract(payload, '$.kind') = 'member-of' AND json_extract(payload, '$.to') LIKE '${list}:%'`
  return Number(
    database
      .prepare(
        `SELECT (SELECT count(*) FROM links WHERE role = ? AND deleted_at IS NULL AND ${links}) + (SELECT count(*) FROM proposed_actions ` +
          `WHERE status = 'proposed' AND ${proposals} AND ((kind = 'relationship' AND json_extract(payload, '$.role') = ?) ` +
          "OR (kind = 'relationship_update' AND json_extract(payload, '$.changes.role') = ?))) AS n",
      )
      .get(role, role, role)?.n,
  )
}

export const relationRolesOver = ({ database, now }: StoreContext): RelationRoles => {
  const all = (list: RoleList): RelationRole[] => [
    ...ROLE_LISTS[list].map((id) => ({ id, label: null, builtIn: true })),
    ...ownerRolesOf(database, list).map((role) => ({ ...role, builtIn: false })),
  ]
  const save = (list: RoleList, roles: { id: string; label: string | null }[]) =>
    database
      .prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, ?)")
      .run(settingOf(list), JSON.stringify(roles.map(({ id, label }) => (label ? { id, label } : { id }))), now())
  return {
    roles: async (list) => all(listOf(list)),
    addRole: async (name, id, label) =>
      write(database, () => {
        const list = listOf(name)
        const role = id.trim()
        if (!/^[a-z][a-z0-9-]{0,39}$/.test(role))
          throw new CliError("validation_error", "a role id is 1–40 lowercase letters, digits and -, from a letter")
        const text = label?.trim() || null
        if (text !== null && text.length > 80)
          throw new CliError("validation_error", "a role's label takes 1–80 characters")
        if (all(list).some((one) => one.id === role))
          throw new CliError("validation_error", `the ${list} roles hold ${role} already`, {
            reason: "relationship.role-exists",
          })
        save(list, [...ownerRolesOf(database, list), { id: role, label: text }])
        return all(list)
      }),
    removeRole: async (name, given) =>
      write(database, () => {
        const list = listOf(name)
        const id = given.trim()
        if ((ROLE_LISTS[list] as readonly string[]).includes(id))
          throw new CliError("validation_error", `${id} is a built-in ${list} role and stays`, {
            reason: "relationship.role-built-in",
          })
        const owned = ownerRolesOf(database, list)
        if (!owned.some((one) => one.id === id)) throw new CliError("not_found", `the ${list} roles hold no ${id}`)
        const held = usedBy(database, list, id)
        if (held)
          throw new CliError("validation_error", `${held} relationship(s) still hold the ${list} role ${id}`, {
            reason: "relationship.role-in-use",
            count: held,
          })
        save(
          list,
          owned.filter((one) => one.id !== id),
        )
        return all(list)
      }),
  }
}
