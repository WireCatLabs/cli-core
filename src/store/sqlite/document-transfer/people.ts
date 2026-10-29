import { CliError } from "@wirecat/cli-base"
import type { TransferSnapshot } from "../../document-transfer/model.js"
import type { CacheDatabase } from "../../driver.js"
import { fold } from "../../normalize.js"
import { ownerPerson } from "../actors.js"
import { stateOfThing, type Thing, thingOf } from "../things.js"

export const planPeople = (
  database: CacheDatabase,
  snapshot: TransferSnapshot,
  mappings: Map<string, Thing>,
  bindings: Record<string, string>,
  conflicts: Set<string>,
) => {
  const creatable = new Set<string>()
  let people = 0,
    identities = 0
  for (const external of snapshot.external) {
    if (!external.person) continue
    const matched = external.person.identities.flatMap((identity) => {
      const row = database
        .prepare(
          "SELECT i.id,l.person_id FROM identities i LEFT JOIN identity_links l ON l.identity_id=i.id WHERE i.provider=? AND i.external_id=?",
        )
        .get(String(identity.provider), String(identity.external_id))
      if (row && row.person_id == null) conflicts.add(`a destination identity has no person for ${external.reference}`)
      if (!row) {
        identities++
        creatable.add(`identity:${String(identity.id)}`)
        return []
      }
      mappings.set(`identity:${String(identity.id)}`, { type: "identity", id: Number(row.id) })
      return row.person_id == null ? [] : [Number(row.person_id)]
    })
    let selected: Thing | undefined = mappings.get(external.key)
    const binding = bindings[external.reference]
    if (binding !== undefined) selected = thingOf(database, binding)
    else if (external.owner) selected = ownerPerson(database)
    else if (new Set(matched).size === 1) selected = { type: "person", id: matched[0] as number }
    if (selected && (selected.type !== "person" || stateOfThing(database, selected) !== "available"))
      selected = undefined
    if (new Set(matched).size > 1 || (selected && matched.some((id) => id !== selected.id)))
      conflicts.add(`source identities disagree with the destination person for ${external.reference}`)
    if (selected) mappings.set(external.key, selected)
    else if (binding === undefined) {
      creatable.add(external.key)
      people++
    }
  }
  return { creatable, people, identities }
}

export const copyPeople = (
  database: CacheDatabase,
  snapshot: TransferSnapshot,
  mappings: Map<string, Thing>,
  now: () => number,
) => {
  for (const external of snapshot.external) {
    if (!external.person) continue
    let person = mappings.get(external.key)
    if (!person) {
      const row = database
        .prepare("INSERT INTO persons (name,owner,created_at,updated_at) VALUES (?,0,?,?) RETURNING id")
        .get(external.person.name, now(), now())
      person = { type: "person", id: Number(row?.id) }
      mappings.set(external.key, person)
    }
    for (const identity of external.person.identities) {
      let row = database
        .prepare(
          "SELECT i.id,l.person_id FROM identities i LEFT JOIN identity_links l ON l.identity_id=i.id WHERE i.provider=? AND i.external_id=?",
        )
        .get(String(identity.provider), String(identity.external_id))
      if (row && Number(row.person_id) !== person.id)
        throw new CliError(
          "configuration_error",
          "an identity belongs to another destination person; the transfer was rolled back",
        )
      if (!row)
        row = database
          .prepare(
            "INSERT INTO identities (provider,external_id,name,name_folded,username,bot,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) RETURNING id",
          )
          .get(
            String(identity.provider),
            String(identity.external_id),
            identity.name ?? null,
            identity.name == null ? null : fold(String(identity.name)),
            identity.username ?? null,
            identity.bot ?? null,
            identity.created_at ?? now(),
            identity.updated_at ?? now(),
          )
      if (!database.prepare("SELECT identity_id FROM identity_links WHERE identity_id=?").get(Number(row?.id)))
        database
          .prepare(
            "INSERT INTO identity_links (identity_id,person_id,method,confidence,author,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
          )
          .run(
            Number(row?.id),
            person.id,
            identity.link_method ?? "transfer",
            identity.link_confidence ?? 1,
            identity.link_author ?? "owner",
            identity.link_source ?? null,
            identity.link_created_at ?? now(),
            identity.link_updated_at ?? now(),
          )
      mappings.set(`identity:${String(identity.id)}`, { type: "identity", id: Number(row?.id) })
    }
  }
}
