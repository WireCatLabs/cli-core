import { CliError } from "@wirecat/cli-base"
import { displayName } from "../../domain/display-names.js"
import { nameSkeletons } from "../../domain/name-variants.js"
import type { IdentityRef, PersonRecord } from "../types.js"
import { ownerPerson } from "./actors.js"
import { openIdentityLink } from "./identity-proposals.js"
import type { StoreContext } from "./open.js"
import { mergePerson, personOf } from "./person-links.js"
import { RULE } from "./person-match-scan.js"
import { separated } from "./person-separation.js"
import { write } from "./transaction.js"

interface OwnIdentity {
  identity: number
  person: number
  name: string | null
}

const ACCOUNT_REASON =
  "an account you connected, under another name: a mailbox or messenger you read may be someone else's"

const ownerNames = ({ database }: StoreContext, owner: number): Set<string>[] =>
  database
    .prepare("SELECT i.name FROM identity_links l JOIN identities i ON i.id = l.identity_id WHERE l.person_id = ?")
    .all(owner)
    .map(({ name }) => new Set(nameSkeletons(displayName(typeof name === "string" ? name : null))))
    .filter((words) => words.size > 0)

/**
 * Whether an account's own name says it is the owner's: no name to say otherwise, or all of its two or more words are
 * in one of the owner's names, script and spelling aside. Before the owner has a name, only the one account a pass
 * finds counts: of two, one may be a partner's. One word (`Ops`) or another person's name is not.
 */
const ownersName = (name: string | null, owner: Set<string>[], alone: boolean): boolean => {
  const words = nameSkeletons(displayName(name))
  if (words.length === 0) return true
  if (owner.length === 0) return alone
  return words.length >= 2 && owner.some((known) => words.every((word) => known.has(word)))
}

/**
 * An account's own identity (same provider and id as the account) is usually the owner. Messengers save it like anyone
 * else's, as a person of its own, so the owner's name counted as a contact's. Links that person to the owner when every
 * account identity on it carries the owner's name, unless the owner separated that person from themselves. Under
 * another name, such as a partner's mailbox or a spouse's messenger the owner reads, it only proposes: nothing joins
 * anyone to the owner without the owner. A bot is never the owner. Nothing to do once done.
 */
export const linkOwnIdentities = (context: StoreContext): number => {
  const owner = ownerPerson(context.database).id
  const byPerson = new Map<number, OwnIdentity[]>()
  for (const row of context.database
    .prepare(
      "SELECT DISTINCT l.person_id AS person, i.id AS identity, i.name, " +
        "(i.bot = 1 OR i.provider LIKE '%-bot') AS bot FROM identity_links l JOIN identities i ON i.id = l.identity_id " +
        "JOIN accounts a ON a.provider = i.provider AND a.external_id = i.external_id WHERE l.person_id <> ? " +
        "ORDER BY i.id",
    )
    .all(owner)) {
    const person = Number(row.person)
    if (row.bot === 1) continue
    const own = byPerson.get(person) ?? []
    own.push({ identity: Number(row.identity), person, name: typeof row.name === "string" ? row.name : null })
    byPerson.set(person, own)
  }
  if (byPerson.size === 0) return 0
  return write(context.database, () => {
    let joined = 0
    for (const [person, own] of byPerson) {
      if (separated(context, person, owner)) continue
      const names = ownerNames(context, owner)
      const other = own.find(({ name }) => !ownersName(name, names, byPerson.size === 1))
      if (other === undefined) {
        mergePerson(context, person, owner, { method: "account", by: "rules" })
        joined += 1
        continue
      }
      openIdentityLink(context, {
        identity: other.identity,
        with: null,
        from: person,
        to: owner,
        joins: "person",
        signal: "account",
        by: RULE,
        reason: ACCOUNT_REASON,
      })
    }
    return joined
  })
}

/** `contacts link <person> me`: an identity the account id does not name, a Zoom user for one, is the owner. */
export const linkToOwner = (context: StoreContext, ref: IdentityRef): PersonRecord => {
  const owner = ownerPerson(context.database).id
  const found = personOf(context, ref)
  if (!found) throw new CliError("not_found", `no ${ref.provider} person ${ref.id} in the store`)
  write(context.database, () => mergePerson(context, Number(found.uid), owner, { method: "manual", by: "owner" }))
  return personOf(context, ref) as PersonRecord
}
