import { CliError } from "@wirecat/cli-base"
import { isEmailAddress, isRoleAddress } from "../../domain/addresses.js"
import { displayName, noFallbacks, takeFallbacks } from "../../domain/display-names.js"
import type { Id, Page } from "../../domain/models.js"
import type {
  IdentityRef,
  LinkedIdentity,
  LinkOptions,
  PersonRecord,
  StoredAccount,
  StoredHit,
  UnlinkOptions,
} from "../types.js"
import { and, eq, inArray, isNull, type SQL, sql } from "./drizzle/core.js"
import { identityOf } from "./identities.js"
import { rejectedEvidence, settleLinks } from "./identity-link-rows.js"
import { currentPerson } from "./merged-persons.js"
import type { StoreContext } from "./open.js"
import { resolvePersonLinks } from "./person-resolution.js"
import { identitySeparated, separated } from "./person-separation.js"
import {
  accountIdentities,
  accounts,
  chats,
  identities,
  identityLinkEvents,
  identityLinks,
  messages,
  persons,
} from "./schema.js"
import { hitsWhere } from "./search.js"

const identityRow = ({ orm }: StoreContext, { provider, id }: IdentityRef) =>
  orm
    .select({ pk: identities.id, personPk: identityLinks.personId })
    .from(identities)
    .innerJoin(identityLinks, eq(identityLinks.identityId, identities.id))
    .where(and(eq(identities.provider, provider), eq(identities.externalId, id)))
    .get()

export const required = (context: StoreContext, ref: IdentityRef) => {
  const found = identityRow(context, ref)
  if (!found) throw new CliError("not_found", `no ${ref.provider} person ${ref.id} in the store`)
  return found
}

export const recordOf = ({ orm }: StoreContext, personPk: number): PersonRecord => {
  const person = orm.select().from(persons).where(eq(persons.id, personPk)).get()
  if (!person) throw new CliError("not_found", "that person is not in the store")
  const rows = orm
    .select({
      pk: identities.id,
      provider: identities.provider,
      id: identities.externalId,
      name: identities.name,
      username: identities.username,
      phone: identities.phone,
      email: identities.email,
      isBot: identities.bot,
      method: identityLinks.method,
      linkedBy: identityLinks.author,
      linkedAt: identityLinks.createdAt,
    })
    .from(identityLinks)
    .innerJoin(identities, eq(identities.id, identityLinks.identityId))
    .where(eq(identityLinks.personId, personPk))
    .orderBy(identities.provider, identities.externalId)
    .all()
  const seen = orm
    .select({ identityPk: accountIdentities.identityId, account: accounts.externalId, scope: accounts.scope })
    .from(accountIdentities)
    .innerJoin(accounts, eq(accounts.id, accountIdentities.accountId))
    .where(
      inArray(
        accountIdentities.identityId,
        rows.map((row) => row.pk),
      ),
    )
    .all()
  const identitiesOf: LinkedIdentity[] = rows.map(({ pk, isBot, linkedAt, ...row }) => {
    const seenIn = seen
      .filter((one) => one.identityPk === pk)
      .map(({ account, scope }) => ({ account, scope: scope as StoredAccount["scope"] }))
    return {
      ...row,
      isBot: isBot === null ? null : isBot === 1,
      accounts: seenIn.map((one) => one.account),
      seenIn,
      linkedAt: new Date(linkedAt).toISOString(),
    }
  })
  const fallbacks = [...rows].sort((a, b) => a.pk - b.pk).reduce(takeFallbacks, noFallbacks())
  return {
    uid: String(person.id),
    name: person.name,
    displayName: displayName(person.name, fallbacks),
    identities: identitiesOf,
  }
}

/**
 * A person by the uid a `person:` reference holds, with every identity linked to them. A uid merged into someone
 * else answers with that person, and `mergedInto` says so.
 */
export const personByUid = (context: StoreContext, uid: string): PersonRecord | undefined => {
  if (!/^[1-9]\d*$/.test(uid) || !Number.isSafeInteger(Number(uid))) return undefined
  const found = context.database.prepare("SELECT id AS pk FROM persons WHERE id = ?").get(uid)
  if (!found) return undefined
  const current = currentPerson(context.database, Number(found.pk))
  const record = recordOf(context, current)
  return current === Number(found.pk) ? record : { ...record, mergedInto: String(current) }
}

/** The person an identity belongs to, with every identity linked to them. */
export const personOf = (context: StoreContext, ref: IdentityRef): PersonRecord | undefined => {
  const found = identityRow(context, ref)
  return found ? recordOf(context, found.personPk) : undefined
}

export const move = (
  context: StoreContext,
  identityPk: number,
  from: number,
  to: number,
  { method, by }: LinkOptions,
) => {
  const at = context.now()
  context.orm
    .update(identityLinks)
    .set({ personId: to, method, confidence: 1, createdAt: at, updatedAt: at, author: by })
    .where(eq(identityLinks.identityId, identityPk))
    .run()
  context.orm
    .insert(identityLinkEvents)
    .values({ identityId: identityPk, fromPersonId: from, toPersonId: to, method, createdAt: at, author: by })
    .run()
}

/**
 * A reviewed meeting participant association moves only its selected identity. Only the owner may move it back
 * over a separation the owner made.
 */
export const linkIdentityToPerson = (
  context: StoreContext,
  identityPk: number,
  target: number,
  options: LinkOptions,
): void => {
  const found = context.orm
    .select({ personId: identityLinks.personId })
    .from(identityLinks)
    .where(eq(identityLinks.identityId, identityPk))
    .get()
  if (options.by !== "owner" && found?.personId !== target && identitySeparated(context, identityPk, target))
    throw new CliError(
      "conflict",
      "the owner separated this identity from that person; only the owner links it again",
      {
        reason: "identity.separated",
      },
    )
  if (found) {
    move(context, identityPk, found.personId, target, options)
    return
  }
  const at = context.now()
  context.orm
    .insert(identityLinks)
    .values({
      identityId: identityPk,
      personId: target,
      method: options.method,
      confidence: 1,
      createdAt: at,
      updatedAt: at,
      author: options.by,
    })
    .run()
  context.orm
    .insert(identityLinkEvents)
    .values({
      identityId: identityPk,
      fromPersonId: null,
      toPersonId: target,
      method: options.method,
      createdAt: at,
      author: options.by,
    })
    .run()
}

/**
 * Makes `other` and everyone already linked to it the same person as `person`. Never inferred from a
 * name: a caller links only what someone decided belongs together, and says how in `method`.
 */
export const linkIdentities = (
  context: StoreContext,
  person: IdentityRef,
  other: IdentityRef,
  options: LinkOptions,
): PersonRecord => {
  const target = required(context, person)
  const moving = required(context, other)
  const record = recordOf(context, mergePerson(context, moving.personPk, target.personPk, options))
  // Two identities that were two people named alike are one now, so a name that was ambiguous may not be.
  resolvePersonLinks(
    context.database,
    record.identities.flatMap(({ name, username }) => [name, username]),
  )
  return record
}

export const isOwner = ({ database }: StoreContext, person: number): boolean =>
  Number(database.prepare("SELECT owner FROM persons WHERE id = ?").get(person)?.owner) === 1

/** The person `mergePerson(one, other)` keeps: `other`, unless `one` is the owner's. */
export const survivorOf = (context: StoreContext, one: number, other: number): number =>
  isOwner(context, one) && !isOwner(context, other) ? one : other

/**
 * Moves every identity of `from` to `to`, as `linkIdentities` does once it has found both people, and gives the
 * person that stays. The owner's person always stays: merging it away would leave the owner with no identity.
 * Proposals naming either person are brought up to date.
 */
export const mergePerson = (context: StoreContext, one: number, other: number, options: LinkOptions): number => {
  if (one === other) return other
  const to = survivorOf(context, one, other)
  const from = to === other ? one : other
  const together = context.orm
    .select({ identityPk: identityLinks.identityId })
    .from(identityLinks)
    .where(eq(identityLinks.personId, from))
    .all()
  for (const { identityPk } of together) move(context, identityPk, from, to, options)
  settleLinks(context.database, [from, to])
  return to
}

/**
 * A company's mailbox joins no one at import: two or more other people hold it (NEED-2446), an organization holds it,
 * or another person of the identity's own list has it, such as a second CRM contact (`sharedLine` in the scan).
 */
const sharedAddress = ({ database }: StoreContext, key: string, found: { pk: number; personPk: number }): boolean => {
  const others = database
    .prepare(
      "SELECT count(DISTINCT l.person_id) AS n FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
        "WHERE i.email = ? AND i.provider NOT IN ('email', 'org-email') AND l.person_id <> ?",
    )
    .get(key, found.personPk)?.n as number
  if (others >= 2) return true
  const self = database.prepare("SELECT provider, external_id FROM identities WHERE id = ?").get(found.pk)
  const list = String(self?.external_id ?? "").replace(/[^/]*$/u, "")
  return (
    database
      .prepare(
        "SELECT 1 FROM identities i WHERE i.email = ? AND (EXISTS (SELECT 1 FROM organization_identities o " +
          "WHERE o.identity_id = i.id) OR (i.provider = ? AND i.id <> ? AND substr(i.external_id, 1, ?) = ? " +
          "AND instr(substr(i.external_id, ? + 1), '/') = 0 AND NOT EXISTS (SELECT 1 FROM identity_links l " +
          "WHERE l.identity_id = i.id AND l.person_id = ?))) LIMIT 1",
      )
      .get(key, String(self?.provider), found.pk, list.length, list, list.length, found.personPk) !== undefined
  )
}

const isBot = ({ database }: StoreContext, identity: number): boolean =>
  database.prepare("SELECT 1 FROM identities WHERE id = ? AND (bot = 1 OR provider LIKE '%-bot')").get(identity) !==
  undefined

/** Keeps the address an identity's source gave it, so a later contact with it counts this one. */
export const noteAddress = (context: StoreContext, ref: IdentityRef, address: string): void => {
  const key = address.trim().toLowerCase()
  if (!isEmailAddress(key) || ref.provider === "email") return
  context.database
    .prepare("UPDATE identities SET email = ? WHERE id = ? AND email IS NOT ?")
    .run(key, required(context, ref).pk, key)
}

/**
 * Joins the identity to the person of the mail contact with this exact address, making that contact when mail has
 * not seen it yet, so whichever import comes second lands on one person. The contact is seen by no account, so it is
 * no one's mail correspondent. An owner's unlink wins: two people the owner separated stay apart. A role address such
 * as `info@` and a company's mailbox join no one, here or in the scan. A pair the owner rejected is not joined either: it is
 * given back, so the caller proposes it when the evidence is new to the owner. Nothing joins the owner, or is
 * proposed to them, from an address: a mailbox the owner reads may be someone else's, and only the owner joins anyone
 * to themselves (SEC-177). A bot or service account joins no one.
 */
export const joinByAddress = (
  context: StoreContext,
  ref: IdentityRef,
  address: string,
  by: string,
): { identity: number; with: number; from: number; to: number } | undefined => {
  const key = address.trim().toLowerCase()
  if (!isEmailAddress(key) || ref.provider === "email") return
  const found = required(context, ref)
  noteAddress(context, ref, key)
  if (isRoleAddress(key)) return
  // The mail contact of the address, found by the address column every contact with one carries (store version 32).
  const mail = context.database
    .prepare("SELECT external_id FROM identities WHERE provider = 'email' AND email = ? LIMIT 1")
    .get(key)
  if (!mail) identityOf(context, "email", key, null)
  const contact = required(context, { provider: "email", id: mail ? String(mail.external_id) : key })
  if (contact.personPk === found.personPk || separated(context, found.personPk, contact.personPk)) return
  if (sharedAddress(context, key, found) || isBot(context, found.pk)) return
  if (isOwner(context, found.personPk) || isOwner(context, contact.personPk)) return
  if (rejectedEvidence(context.database, found.personPk, contact.personPk) !== undefined)
    return { identity: found.pk, with: contact.pk, from: found.personPk, to: contact.personPk }
  const kept = mergePerson(context, found.personPk, contact.personPk, { method: "same-email", by })
  resolvePersonLinks(
    context.database,
    recordOf(context, kept).identities.flatMap(({ name, username }) => [name, username]),
  )
  return undefined
}

/**
 * A person named after an identity that left them takes the name of the oldest identity they still have, or none: the
 * owner merged with a partner's CRM contact kept the partner's name after the split (BUG-677).
 */
export const renameAfterLeaving = (context: StoreContext, person: number, left: readonly number[]): void => {
  const { database } = context
  const current = database.prepare("SELECT name FROM persons WHERE id = ?").get(person)?.name
  if (typeof current !== "string") return
  const leaving = database
    .prepare("SELECT name FROM identities WHERE id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(left))
    .map(({ name }) => (typeof name === "string" ? name.trim() : ""))
  if (!leaving.includes(current.trim())) return
  const kept = database
    .prepare(
      "SELECT i.name FROM identity_links l JOIN identities i ON i.id = l.identity_id " +
        "WHERE l.person_id = ? AND trim(coalesce(i.name, '')) <> '' ORDER BY l.created_at, i.id LIMIT 1",
    )
    .get(person)?.name
  database
    .prepare("UPDATE persons SET name = ?, updated_at = ? WHERE id = ?")
    .run(typeof kept === "string" ? kept : null, context.now(), person)
}

const shownAs = (person: PersonRecord) =>
  `${displayName(person.name, { name: person.identities.find((identity) => identity.name)?.name ?? null }) ?? "a person with no name"} (person:${person.uid})`

/**
 * Refuses identities that sit on anyone but `from` (a uid, or `person:<uid>` as doubts and refusals give it), so a
 * caller that guessed the person never takes them off someone else. The refusal names who holds them.
 */
export const heldBy = (context: StoreContext, from: string, refs: readonly IdentityRef[]): void => {
  const uid = from.startsWith("person:") ? from.slice("person:".length) : from
  const found = /^[1-9]\d*$/.test(uid)
    ? context.database.prepare("SELECT id FROM persons WHERE id = ?").get(uid)
    : undefined
  if (found === undefined) throw new CliError("not_found", `no person:${uid} in the store`, { param: "from" })
  const pk = currentPerson(context.database, Number(found.id))
  for (const ref of refs) {
    const row = required(context, ref)
    if (row.personPk === pk) continue
    const holder = recordOf(context, row.personPk)
    throw new CliError(
      "validation_error",
      `${ref.provider}:${ref.id} sits on ${shownAs(holder)}, not on ${shownAs(recordOf(context, pk))}; nothing changed. ` +
        `Name person:${holder.uid} to take it off them`,
      { reason: "identity.held-elsewhere", param: "from", reference: `person:${holder.uid}` },
    )
  }
}

/** Gives the identity a person of its own again; the ones left keep theirs. */
export const unlinkIdentity = (context: StoreContext, ref: IdentityRef, options: UnlinkOptions): PersonRecord => {
  if (options.from !== undefined) heldBy(context, options.from, [ref])
  const found = required(context, ref)
  const others = context.orm
    .select({ n: sql<number>`count(*)` })
    .from(identityLinks)
    .where(eq(identityLinks.personId, found.personPk))
    .get()
  if (Number(others?.n) <= 1)
    throw new CliError("validation_error", `${ref.provider} ${ref.id} is not linked to anyone`)
  const at = context.now()
  const named = context.orm.select({ name: identities.name }).from(identities).where(eq(identities.id, found.pk)).get()
  const alone = Number(
    context.orm
      .insert(persons)
      .values({ name: named?.name ?? null, createdAt: at, updatedAt: at })
      .returning({ pk: persons.id })
      .get()?.pk,
  )
  move(context, found.pk, found.personPk, alone, { method: "unlink", by: options.by })
  renameAfterLeaving(context, found.personPk, [found.pk])
  return recordOf(context, alone)
}

/** Messages that name the person: by id where the messenger said so, or by `@username` in the text. */
export const mentioning = (
  context: StoreContext,
  accountKey: number,
  { id, username }: { id: Id; username: string | null },
  limit: number,
): Page<StoredHit> => {
  const byId = sql`EXISTS (SELECT 1 FROM json_each(${messages.mentions}) WHERE json_each.value = ${id})`
  const byHandle: SQL | undefined =
    username === null ? undefined : sql`instr(lower(${messages.text}), ${`@${username.toLowerCase()}`}) > 0`
  const where = and(
    eq(messages.accountId, accountKey),
    eq(chats.searchable, 1),
    isNull(messages.deletedAt),
    byHandle ? sql`(${byId} OR ${byHandle})` : byId,
  )
  // instr finds "@ana" inside "@anastasia" too; the word boundary is checked here.
  const handle = username === null ? undefined : new RegExp(`@${escaped(username)}(?![\\p{L}\\p{N}_])`, "iu")
  const page = hitsWhere(context, where, limit)
  return {
    ...page,
    items: page.items.filter((hit) => hit.mentions?.includes(id) || handle?.test(hit.text)),
  }
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
