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
  bot: boolean
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
 * Whether an account's own name says it is the owner's: no name to say otherwise, the owner has no name yet, or all of
 * its two or more words are in one of the owner's names, script and spelling aside. One word (`Ops`) or another
 * person's name is not.
 */
const ownersName = (name: string | null, owner: Set<string>[]): boolean => {
  const words = nameSkeletons(displayName(name))
  if (words.length === 0 || owner.length === 0) return true
  return words.length >= 2 && owner.some((known) => words.every((word) => known.has(word)))
}

/**
 * An account's own identity (same provider and id as the account) is usually the owner. Messengers save it like anyone
 * else's, as a person of its own, so the owner's name counted as a contact's. Links it, and whoever was linked with it,
 * to the owner when its name is the owner's, unless the owner separated that person from themselves. Under another
 * name, such as a partner's mailbox or a spouse's messenger the owner reads, it only proposes: nothing joins anyone to
 * the owner without the owner (SEC-177). A bot is never the owner. Nothing to do once done.
 */
export const linkOwnIdentities = (context: StoreContext): number => {
  const owner = ownerPerson(context.database).id
  const strays: OwnIdentity[] = context.database
    .prepare(
      "SELECT DISTINCT l.person_id AS person, i.id AS identity, i.name, " +
        "(i.bot = 1 OR i.provider LIKE '%-bot') AS bot FROM identity_links l JOIN identities i ON i.id = l.identity_id " +
        "JOIN accounts a ON a.provider = i.provider AND a.external_id = i.external_id WHERE l.person_id <> ?",
    )
    .all(owner)
    .map((row) => ({
      identity: Number(row.identity),
      person: Number(row.person),
      name: typeof row.name === "string" ? row.name : null,
      bot: row.bot === 1,
    }))
  if (strays.length === 0) return 0
  return write(context.database, () => {
    const names = ownerNames(context, owner)
    let joined = 0
    for (const stray of strays) {
      if (stray.bot || separated(context, stray.person, owner)) continue
      if (ownersName(stray.name, names)) {
        mergePerson(context, stray.person, owner, { method: "account", by: "rules" })
        joined += 1
        continue
      }
      openIdentityLink(context, {
        identity: stray.identity,
        with: null,
        from: stray.person,
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
