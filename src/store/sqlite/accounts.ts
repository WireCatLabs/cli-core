import { CliError } from "@wirecat/cli-base"
import type { CacheDatabase } from "../driver.js"
import type { AccountKey, StoredAccount } from "../types.js"
import { and, asc, eq, inArray, sql } from "./drizzle/core.js"
import { pointerPairs } from "./entity-types.js"
import type { StoreContext } from "./open.js"
import {
  accountIdentities,
  accounts,
  aliases,
  botUpdates,
  chatEventPeople,
  chatEvents,
  chatMembers,
  chats,
  chunks,
  fetchLeases,
  involvements,
  memberCounts,
  memberObservationMembers,
  memberObservations,
  memberStays,
  messageReactions,
  messageRevisions,
  messages,
  messageTranscripts,
  pollVotes,
  projects,
  syncCursors,
  syncRanges,
  syncs,
} from "./schema.js"
import { dropUnusedVectors } from "./vector-index.js"

/** An account's row, made on first sight; a name only replaces what was known when there is one. */
export const accountPk = (
  { orm, now }: StoreContext,
  { provider, account, scope }: AccountKey,
  name: string | null = null,
) =>
  Number(
    orm
      .insert(accounts)
      .values({ provider, externalId: account, name, scope: scope ?? "personal", createdAt: now(), updatedAt: now() })
      .onConflictDoUpdate({
        target: [accounts.provider, accounts.externalId],
        set: {
          scope: scope ?? sql`${accounts.scope}`,
          name: sql`coalesce(excluded.name, ${accounts.name})`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
      .returning({ pk: accounts.id })
      .get()?.pk,
  )

export const findAccountPk = ({ orm }: StoreContext, { provider, account }: AccountKey): number | undefined =>
  orm
    .select({ pk: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.provider, provider), eq(accounts.externalId, account)))
    .get()?.pk

export const accountName = ({ orm }: StoreContext, { provider, account }: AccountKey): string | null =>
  orm
    .select({ name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.provider, provider), eq(accounts.externalId, account)))
    .get()?.name ?? null

export const heldAccounts = ({ orm }: StoreContext): AccountKey[] =>
  orm
    .select({ provider: accounts.provider, account: accounts.externalId })
    .from(accounts)
    .orderBy(asc(accounts.provider), asc(accounts.externalId))
    .all()

/** Every account with the store's id for it, by provider then external id. */
const STORED = {
  id: accounts.id,
  provider: accounts.provider,
  account: accounts.externalId,
  name: accounts.name,
  scope: accounts.scope,
}

export const storedAccounts = ({ orm }: StoreContext): StoredAccount[] =>
  orm.select(STORED).from(accounts).orderBy(asc(accounts.provider), asc(accounts.externalId)).all() as StoredAccount[]

/** One account by provider and external id, never created; a missing one is `not_found`. */
export const storedAccount = ({ orm }: StoreContext, { provider, account }: AccountKey): StoredAccount => {
  const found = orm
    .select(STORED)
    .from(accounts)
    .where(and(eq(accounts.provider, provider), eq(accounts.externalId, account)))
    .get()
  if (!found) throw new CliError("not_found", `no ${provider} account ${account} in the store`)
  return found as StoredAccount
}

/** Everything the account holds, children before parents: the foreign keys are enforced. */
export const purgeAccount = ({ orm, database }: StoreContext, accountKey: number): void => {
  const unseenBefore = unreferenced(database, "identities")
  const chatsOf = orm.select({ pk: chats.id }).from(chats).where(eq(chats.accountId, accountKey))
  const messagesOf = orm.select({ pk: messages.id }).from(messages).where(eq(messages.accountId, accountKey))
  orm.delete(botUpdates).where(eq(botUpdates.accountId, accountKey)).run()
  orm.delete(involvements).where(eq(involvements.accountId, accountKey)).run()
  // Vectors are keyed by text: those of this account's pieces go at the end, unless another piece holds that text.
  const hashes = orm
    .all<{ hash: string }>(sql`SELECT DISTINCT content_hash AS hash FROM chunks WHERE account_id = ${accountKey}`)
    .map(({ hash }) => hash)
  orm.delete(chunks).where(eq(chunks.accountId, accountKey)).run()
  orm.delete(aliases).where(eq(aliases.accountId, accountKey)).run()
  orm.delete(syncs).where(eq(syncs.accountId, accountKey)).run()
  orm.delete(messageTranscripts).where(inArray(messageTranscripts.chatId, chatsOf)).run()
  orm.delete(pollVotes).where(inArray(pollVotes.chatId, chatsOf)).run()
  orm.delete(messageReactions).where(inArray(messageReactions.chatId, chatsOf)).run()
  orm
    .delete(chatEventPeople)
    .where(
      inArray(
        chatEventPeople.chatEventId,
        orm.select({ id: chatEvents.id }).from(chatEvents).where(inArray(chatEvents.chatId, chatsOf)),
      ),
    )
    .run()
  orm.delete(chatEvents).where(inArray(chatEvents.chatId, chatsOf)).run()
  orm.delete(fetchLeases).where(inArray(fetchLeases.chatId, chatsOf)).run()
  orm.delete(chatMembers).where(inArray(chatMembers.chatId, chatsOf)).run()
  const observationsOf = orm
    .select({ id: memberObservations.id })
    .from(memberObservations)
    .where(inArray(memberObservations.chatId, chatsOf))
  orm
    .delete(memberObservationMembers)
    .where(inArray(memberObservationMembers.memberObservationId, observationsOf))
    .run()
  orm.delete(memberObservations).where(inArray(memberObservations.chatId, chatsOf)).run()
  orm.delete(memberStays).where(inArray(memberStays.chatId, chatsOf)).run()
  orm.delete(memberCounts).where(inArray(memberCounts.chatId, chatsOf)).run()
  orm.delete(syncRanges).where(inArray(syncRanges.chatId, chatsOf)).run()
  orm.delete(messageRevisions).where(inArray(messageRevisions.messageId, messagesOf)).run()
  orm.delete(messages).where(eq(messages.accountId, accountKey)).run()
  orm.delete(chats).where(eq(chats.accountId, accountKey)).run()
  orm.delete(syncCursors).where(eq(syncCursors.accountId, accountKey)).run()
  orm.run(
    sql`DELETE FROM email_locations WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE account_id = ${accountKey})`,
  )
  // Deleting an email clears its recipients, mailboxes, words, attachments and tags (trigger email_bd).
  orm.run(sql`DELETE FROM emails WHERE account_id = ${accountKey}`)
  orm.run(
    sql`DELETE FROM taggings WHERE taggable_type = 'email_thread' AND taggable_id IN (SELECT id FROM email_threads WHERE account_id = ${accountKey})`,
  )
  orm.run(sql`DELETE FROM email_threads WHERE account_id = ${accountKey}`)
  orm.run(sql`DELETE FROM mailboxes WHERE account_id = ${accountKey}`)
  // Meetings have no delete trigger: children first, then what points at a meeting, then the meetings.
  const meetingsOf = sql`(SELECT id FROM meetings WHERE account_id = ${accountKey})`
  orm.run(
    sql`DELETE FROM meeting_transcript_rows WHERE meeting_transcript_id IN (SELECT id FROM meeting_transcripts WHERE meeting_id IN ${meetingsOf})`,
  )
  orm.run(sql`DELETE FROM meeting_transcripts WHERE meeting_id IN ${meetingsOf}`)
  orm.run(sql`DELETE FROM meeting_chat_messages WHERE meeting_id IN ${meetingsOf}`)
  orm.run(sql`DELETE FROM meeting_summaries WHERE meeting_id IN ${meetingsOf}`)
  orm.run(sql`DELETE FROM meeting_participants WHERE meeting_id IN ${meetingsOf}`)
  orm.run(sql`DELETE FROM attachments WHERE attachable_type = 'meeting' AND attachable_id IN ${meetingsOf}`)
  orm.run(sql`DELETE FROM taggings WHERE taggable_type = 'meeting' AND taggable_id IN ${meetingsOf}`)
  orm.run(
    sql`DELETE FROM links WHERE (from_type = 'meeting' AND from_id IN ${meetingsOf}) OR (to_type = 'meeting' AND to_id IN ${meetingsOf})`,
  )
  orm.run(sql`DELETE FROM meetings WHERE account_id = ${accountKey}`)
  orm.run(sql`DELETE FROM meeting_series WHERE account_id = ${accountKey}`)
  orm.delete(accountIdentities).where(eq(accountIdentities.accountId, accountKey)).run()
  // The inbox project and its tasks are the owner's; only the tie to the account goes.
  orm.update(projects).set({ accountId: null }).where(eq(projects.accountId, accountKey)).run()
  orm.run(sql`DELETE FROM files WHERE account_id = ${accountKey}`)
  orm.delete(accounts).where(eq(accounts.id, accountKey)).run()
  dropOrphanPeople(database, unseenBefore)
  dropUnusedVectors(database, hashes)
}

/** Identity and person rows a person's own record keeps, not evidence that anyone saw them. */
const OWN = new Set(["identity_links", "identity_link_events", "identity_revisions"])

/** Every row that points at `table`: foreign keys and `<name>_type` pointers, read from the store so a new one counts. */
const referencesTo = (database: CacheDatabase, table: "identities" | "persons", skip: Set<string>): string => {
  const keys = database
    .prepare(
      `SELECT m.name AS tbl, f."from" AS col FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
        WHERE m.type = 'table' AND f."table" = ?`,
    )
    .all(table)
    .filter((row) => !skip.has(String(row.tbl)))
    .map((row) => `SELECT "${String(row.col)}" AS id FROM "${String(row.tbl)}"`)
  const type = table === "identities" ? "identity" : "person"
  const pointers = pointerPairs(database).map(
    ({ table: tbl, pointer }) => `SELECT ${pointer}_id AS id FROM "${tbl}" WHERE ${pointer}_type = '${type}'`,
  )
  return [...keys, ...pointers].join(" UNION ")
}

const unreferenced = (database: CacheDatabase, table: "identities"): Set<number> =>
  new Set(
    database
      .prepare(
        `SELECT id FROM ${table} WHERE id NOT IN (SELECT id FROM (${referencesTo(database, table, OWN)}) WHERE id IS NOT NULL)`,
      )
      .all()
      .map(({ id }) => Number(id)),
  )

/**
 * People only the purged account had seen go with it. An identity stays while anything else points at it
 * (another account, a tag, a note, a link), or while its person is kept: the owner, a person something
 * points at, or one linked to an identity that stays.
 */
const dropOrphanPeople = (database: CacheDatabase, unseenBefore: Set<number>) => {
  const orphans = [...unreferenced(database, "identities")].filter((id) => !unseenBefore.has(id))
  if (orphans.length === 0) return
  const ids = JSON.stringify(orphans)
  const personRefs = referencesTo(database, "persons", OWN)
  const kept = new Set(
    database
      .prepare(
        `SELECT DISTINCT l.identity_id AS id FROM identity_links l JOIN persons p ON p.id = l.person_id
          WHERE l.identity_id IN (SELECT value FROM json_each(?)) AND (p.owner <> 0
            OR p.id IN (SELECT id FROM (${personRefs}) WHERE id IS NOT NULL)
            OR EXISTS (SELECT 1 FROM identity_links o WHERE o.person_id = p.id
              AND o.identity_id NOT IN (SELECT value FROM json_each(?))))`,
      )
      .all(ids, ids)
      .map(({ id }) => Number(id)),
  )
  const gone = JSON.stringify(orphans.filter((id) => !kept.has(id)))
  const persons = database
    .prepare(
      "SELECT DISTINCT person_id AS id FROM identity_links WHERE identity_id IN (SELECT value FROM json_each(?))",
    )
    .all(gone)
    .map(({ id }) => Number(id))
  for (const table of ["identity_revisions", "identity_link_events", "identity_links"])
    database.prepare(`DELETE FROM ${table} WHERE identity_id IN (SELECT value FROM json_each(?))`).run(gone)
  database.prepare("DELETE FROM identities WHERE id IN (SELECT value FROM json_each(?))").run(gone)
  database
    .prepare(
      `DELETE FROM persons WHERE id IN (SELECT value FROM json_each(?)) AND owner = 0
        AND NOT EXISTS (SELECT 1 FROM identity_links l WHERE l.person_id = persons.id)
        AND id NOT IN (SELECT id FROM (${referencesTo(database, "persons", new Set(["identity_links"]))}) WHERE id IS NOT NULL)`,
    )
    .run(JSON.stringify(persons))
}
