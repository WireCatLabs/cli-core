import { CliError } from "@wirecat/cli-base"
import type { IdentityRef, PersonRecord } from "../types.js"
import { ownerPerson } from "./actors.js"
import type { StoreContext } from "./open.js"
import { mergePerson, personOf } from "./person-links.js"
import { write } from "./transaction.js"

/**
 * An account's own identity (same provider and id as the account) is the owner. Messengers save it like anyone
 * else's, as a person of its own, so the owner's name counted as a contact's. Links it, and whoever was linked
 * with it, to the owner; nothing to do once done.
 */
export const linkOwnIdentities = (context: StoreContext): number => {
  const owner = ownerPerson(context.database).id
  const strays = context.database
    .prepare(
      "SELECT DISTINCT l.person_id AS person FROM identity_links l JOIN identities i ON i.id = l.identity_id " +
        "JOIN accounts a ON a.provider = i.provider AND a.external_id = i.external_id WHERE l.person_id <> ?",
    )
    .all(owner)
  if (strays.length === 0) return 0
  write(context.database, () => {
    for (const { person } of strays) mergePerson(context, Number(person), owner, { method: "account", by: "rules" })
  })
  return strays.length
}

/** `contacts link <person> me`: an identity the account id does not name, a Zoom user for one, is the owner. */
export const linkToOwner = (context: StoreContext, ref: IdentityRef): PersonRecord => {
  const owner = ownerPerson(context.database).id
  const found = personOf(context, ref)
  if (!found) throw new CliError("not_found", `no ${ref.provider} person ${ref.id} in the store`)
  write(context.database, () => mergePerson(context, Number(found.uid), owner, { method: "manual", by: "owner" }))
  return personOf(context, ref) as PersonRecord
}
