import type { CacheDatabase } from "../driver.js"
import { dropOrphanPeople, unreferenced } from "./accounts.js"
import { calendarCursorKey, calendarWritesOver } from "./calendar.js"
import { forgetCalendarRows } from "./calendar-forget.js"
import { eq, inArray, sql } from "./drizzle/core.js"
import { forgetDanglingEvidence, forgetEvidenceTo } from "./evidence-signature.js"
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

/** Everything the account holds, children before parents: the foreign keys are enforced. */
export const purgeAccount = (context: StoreContext, accountKey: number): void => {
  const { orm, database, now } = context
  const unseenBefore = unreferenced(database, "identities")
  const at = now()
  const meetingIds = "SELECT id FROM meetings WHERE account_id = ?"
  const transcriptIds = `SELECT id FROM meeting_transcripts WHERE meeting_id IN (${meetingIds})`
  for (const [type, sql] of [
    ["message", "SELECT id FROM messages WHERE account_id = ?"],
    ["chat", "SELECT id FROM chats WHERE account_id = ?"],
    ["email", "SELECT id FROM emails WHERE account_id = ?"],
    ["email_thread", "SELECT id FROM email_threads WHERE account_id = ?"],
    ["meeting", meetingIds],
    ["meeting_transcript", transcriptIds],
    [
      "meeting_transcript_row",
      `SELECT id FROM meeting_transcript_rows WHERE meeting_transcript_id IN (${transcriptIds})`,
    ],
  ] as const)
    forgetEvidenceTo(database, type, { sql, params: [accountKey] }, at)
  const { refreshEvent, refreshSeries } = calendarWritesOver(context)
  for (const { id } of database.prepare("SELECT id FROM calendars WHERE account_id = ?").all(accountKey))
    forgetCalendarRows(
      database,
      { calendarId: Number(id), accountId: accountKey, cursorKey: calendarCursorKey(Number(id)), now: at },
      { event: refreshEvent, series: refreshSeries },
    )
  for (const table of ["mail_rules", "reminders", "proposed_actions"])
    database.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(accountKey)
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
  // Deleting a document clears its pieces, words, revisions, tags and own links (trigger document_bd).
  const documentsOf = sql`(SELECT id FROM documents WHERE account_id = ${accountKey})`
  orm.run(sql`DELETE FROM links WHERE to_type = 'document' AND to_id IN ${documentsOf}`)
  orm.run(sql`UPDATE files SET document_id = NULL WHERE document_id IN ${documentsOf}`)
  orm.run(sql`DELETE FROM documents WHERE account_id = ${accountKey}`)
  purgeCrmCopies(database, accountKey)
  orm.run(sql`DELETE FROM crm_fields WHERE account_id = ${accountKey}`)
  // An entity made from a record is the owner's and stays; only what the source said goes.
  const recordsOf = sql`(SELECT id FROM records WHERE account_id = ${accountKey})`
  orm.run(sql`DELETE FROM record_relations WHERE record_id IN ${recordsOf} OR target_id IN ${recordsOf}`)
  orm.run(sql`DELETE FROM records WHERE account_id = ${accountKey}`)
  orm.delete(accounts).where(eq(accounts.id, accountKey)).run()
  dropOrphanPeople(database, unseenBefore)
  forgetDanglingEvidence(database, at)
  dropUnusedVectors(database, hashes)
  // The links' delete trigger writes a revision naming the account it is purging; the history goes with the links.
  orm.run(sql`DELETE FROM link_revisions WHERE account_id = ${accountKey}`)
}

/**
 * A CRM's deals, leads and pipelines with their stages, children first. Another account's lead converted from one
 * of these deals, and an order or contract that names one, keep their row and lose only the link.
 */
const purgeCrmCopies = (database: CacheDatabase, accountKey: number): void => {
  const run = (statement: string, ...params: (string | number)[]) => database.prepare(statement).run(...params)
  const dealsOf = "(SELECT id FROM deals WHERE account_id = ?)"
  const leadsOf = "(SELECT id FROM leads WHERE account_id = ?)"
  const pipelinesOf = "(SELECT id FROM pipelines WHERE account_id = ?)"
  const stagesOf = `(SELECT id FROM pipeline_stages WHERE pipeline_id IN ${pipelinesOf})`
  for (const [type, ids] of [
    ["deal", dealsOf],
    ["lead", leadsOf],
  ] as const) {
    run(
      `DELETE FROM links WHERE (from_type = ? AND from_id IN ${ids}) OR (to_type = ? AND to_id IN ${ids})`,
      type,
      accountKey,
      type,
      accountKey,
    )
    for (const [table, pointer] of [
      ["taggings", "taggable"],
      ["aliases", "aliasable"],
      ["attachments", "attachable"],
      ["link_reviews", "linkable"],
      ["entity_link_events", "linkable"],
    ])
      run(`DELETE FROM ${table} WHERE ${pointer}_type = ? AND ${pointer}_id IN ${ids}`, type, accountKey)
    run(`DELETE FROM pipeline_stage_changes WHERE item_type = ? AND item_id IN ${ids}`, type, accountKey)
  }
  run(`DELETE FROM pipeline_stage_changes WHERE pipeline_id IN ${pipelinesOf}`, accountKey)
  for (const table of ["leads", "orders", "contracts"])
    run(`UPDATE ${table} SET deal_id = NULL WHERE deal_id IN ${dealsOf}`, accountKey)
  run("DELETE FROM leads WHERE account_id = ?", accountKey)
  run("DELETE FROM deals WHERE account_id = ?", accountKey)
  run(`UPDATE pipeline_stages SET base_stage_id = NULL WHERE base_stage_id IN ${stagesOf}`, accountKey)
  run(`DELETE FROM pipeline_stages WHERE pipeline_id IN ${pipelinesOf}`, accountKey)
  run("DELETE FROM pipelines WHERE account_id = ?", accountKey)
}
