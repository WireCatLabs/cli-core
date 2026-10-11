import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import type { Id } from "../../domain/models.js"
import type { AgentAnswer, BatchMessage, LinkBatch } from "../store.js"
import { type SQL, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import { toIso } from "./values.js"

/** How many messages before the first one to answer the agent sees: 97% of reply parents sit within 50. */
export const BATCH_CONTEXT = 50

/**
 * Phase 4 plan A2: a live message the agent is asked about — no reply the messenger itself records to a
 * message held here, and no current agent answer. A stale answer makes it need the agent again.
 */
const replied = (m: SQL) => sql`EXISTS (SELECT 1 FROM messages p WHERE p.chat_id = ${m}.chat_id
  AND p.external_id = ${m}.reply_to_external_id AND p.deleted_at IS NULL)`

const needsAgent = (m: SQL) => sql`(
  NOT ${replied(m)}
  AND NOT EXISTS (SELECT 1 FROM message_links l WHERE l.message_id = ${m}.id AND l.source = 'agent'
    AND l.stale_at IS NULL))`

interface Row {
  pk: number
  external_id: string
  sent_at: number
  text: string
  sender_id: string | null
  sender_name: string | null
  reply_to_external_id: string | null
  thread_external_id: string | null
  mentions: string | null
  needs: number
  replied: number
}

const COLUMNS = sql`m.id AS pk, m.external_id, m.sent_at, m.text, coalesce(m.sender_chat_external_id, i.external_id) AS sender_id,
  m.sender_name, m.reply_to_external_id, m.thread_external_id, m.mentions, ${needsAgent(sql`m`)} AS needs,
  ${replied(sql`m`)} AS replied`
const FROM = sql`messages m LEFT JOIN identities i ON i.id = m.sender_identity_id`

/**
 * `b1.<chat>.<first>.<last>.<hash>` (A3): the first and last message to answer, and a hash of every live
 * message between them. Answering some of them leaves the id valid; a message added or deleted inside
 * the window does not, so an answer is never checked against a window that moved.
 */
export const batchId = (chatKey: number, span: number[]): string =>
  `b1.${chatKey}.${span[0]}.${span.at(-1)}.${createHash("sha256").update(span.join(",")).digest("hex").slice(0, 12)}`

/** How much is left to answer, for the agent to tell the user before it starts (A7). */
export const batchStatus = ({ orm }: StoreContext, chatKey: number) => {
  const row = orm.get<{ messages: number; characters: number | null }>(
    sql`SELECT count(*) AS messages, sum(length(m.text)) AS characters FROM messages m
      WHERE m.chat_id = ${chatKey} AND m.deleted_at IS NULL AND ${needsAgent(sql`m`)}`,
  )
  return { messages: Number(row?.messages ?? 0), characters: Number(row?.characters ?? 0) }
}

/**
 * The earliest window that holds a message needing the agent (A1–A2): from that message, the next
 * `size` live messages — those needing the agent are the core, the rest context — and the `BATCH_CONTEXT`
 * messages before it. `undefined` when nothing is left to answer.
 */
export const nextBatch = (
  context: StoreContext,
  chatKey: number,
  chatId: Id,
  size: number,
): Omit<LinkBatch, "remaining"> | undefined => {
  const { orm } = context
  const first = orm.get<{ pk: number; sent_at: number }>(
    sql`SELECT m.id AS pk, m.sent_at FROM messages m WHERE m.chat_id = ${chatKey} AND m.deleted_at IS NULL
      AND ${needsAgent(sql`m`)} ORDER BY m.sent_at, m.id LIMIT 1`,
  )
  if (!first) return undefined
  const live = sql`m.chat_id = ${chatKey} AND m.deleted_at IS NULL`
  const span = orm.all<Row>(
    sql`SELECT ${COLUMNS} FROM ${FROM} WHERE ${live} AND (m.sent_at, m.id) >= (${first.sent_at}, ${first.pk})
      ORDER BY m.sent_at, m.id LIMIT ${size}`,
  )
  const before = orm
    .all<Row>(
      sql`SELECT ${COLUMNS} FROM ${FROM} WHERE ${live} AND (m.sent_at, m.id) < (${first.sent_at}, ${first.pk})
        ORDER BY m.sent_at DESC, m.id DESC LIMIT ${BATCH_CONTEXT}`,
    )
    .reverse()
  const core = span.filter((row) => Number(row.needs) === 1)
  const candidates = candidatesOf(
    context,
    core.map(({ pk }) => pk),
  )
  const last = span.findLastIndex((row) => Number(row.needs) === 1)
  return {
    batch: batchId(
      chatKey,
      span.slice(0, last + 1).map(({ pk }) => pk),
    ),
    chat: chatId,
    messages: [...before, ...span].map((row) => toBatchMessage(row, candidates.get(row.pk))),
  }
}

/** The current build's messenger and rule links for the core: the rules' guesses, for the agent to weigh. */
const candidatesOf = ({ orm }: StoreContext, pks: number[]) => {
  const found = new Map<number, BatchMessage["candidates"]>()
  if (pks.length === 0) return found
  const rows = orm.all<{ message_id: number; parent: string | null; source: string; kind: string; confidence: number }>(
    sql`SELECT l.message_id, p.external_id AS parent, l.source, l.kind, l.confidence
      FROM message_links l LEFT JOIN messages p ON p.id = l.parent_id
      WHERE l.message_id IN (${sql.join(
        pks.map((pk) => sql`${pk}`),
        sql`, `,
      )}) AND l.source IN ('provider', 'rule')
        AND l.build = (SELECT s.current_build FROM conversation_state s WHERE s.chat_id = l.chat_id)
      ORDER BY l.message_id, l.confidence DESC`,
  )
  for (const row of rows) {
    found.set(row.message_id, [
      ...(found.get(row.message_id) ?? []),
      { parent: row.parent, source: row.source, kind: row.kind, confidence: row.confidence },
    ])
  }
  return found
}

const toBatchMessage = (row: Row, candidates: BatchMessage["candidates"] | undefined): BatchMessage => ({
  id: row.external_id,
  at: toIso(row.sent_at) as string,
  sender: { id: row.sender_id, name: row.sender_name },
  text: row.text,
  ...(row.reply_to_external_id === null ? {} : { replyTo: row.reply_to_external_id }),
  ...(row.thread_external_id === null ? {} : { thread: row.thread_external_id }),
  ...(row.mentions === null ? {} : { mentions: JSON.parse(row.mentions) as Id[] }),
  answer: Number(row.needs) === 1,
  ...(Number(row.needs) === 1 ? { candidates: candidates ?? [] } : {}),
})

const BATCH_ID = /^b1\.(\d+)\.(\d+)\.(\d+)\.[0-9a-f]{12}$/

const refused = (why: string) => new CliError("validation_error", `the answer was not stored: ${why}`)

/** The messages a batch id names, read again: the context before it and the window itself. */
const windowOf = (context: StoreContext, id: string) => {
  const { orm } = context
  const [, chat, first, last] = BATCH_ID.exec(id) ?? []
  if (!chat) throw refused(`${id} is not a batch id from \`conversations batches next\``)
  const chatKey = Number(chat)
  const ends = orm.all<{ pk: number; sent_at: number }>(
    sql`SELECT id AS pk, sent_at FROM messages WHERE chat_id = ${chatKey} AND deleted_at IS NULL AND id IN (${Number(first)}, ${Number(last)})
      ORDER BY sent_at, id`,
  )
  const [from, to] = ends.length === 1 ? [ends[0], ends[0]] : ends
  if (!from || !to) throw refused("the chat changed under this batch — ask for a new one")
  const live = sql`m.chat_id = ${chatKey} AND m.deleted_at IS NULL`
  const span = orm.all<Row>(
    sql`SELECT ${COLUMNS} FROM ${FROM} WHERE ${live}
      AND (m.sent_at, m.id) >= (${from.sent_at}, ${from.pk}) AND (m.sent_at, m.id) <= (${to.sent_at}, ${to.pk})
      ORDER BY m.sent_at, m.id`,
  )
  if (
    batchId(
      chatKey,
      span.map(({ pk }) => pk),
    ) !== id
  ) {
    throw refused("the chat changed under this batch — ask for a new one")
  }
  const before = orm.all<Row>(
    sql`SELECT ${COLUMNS} FROM ${FROM} WHERE ${live} AND (m.sent_at, m.id) < (${from.sent_at}, ${from.pk})
      ORDER BY m.sent_at DESC, m.id DESC LIMIT ${BATCH_CONTEXT}`,
  )
  return { chatKey, span, before }
}

/** The chat a batch id names, for the facade to check it belongs to the account. */
export const chatOfBatch = (id: string): number | undefined => {
  const chat = BATCH_ID.exec(id)?.[1]
  return chat === undefined ? undefined : Number(chat)
}

/**
 * The agent's answer to a batch (A5), checked whole before anything is stored: every message is one
 * the batch asked about, each parent is in the batch and earlier, no message twice, confidence 0–1, a
 * model named. A message's new answer replaces its earlier one. Runs inside the caller's transaction.
 */
export const saveAnswers = (context: StoreContext, id: string, answer: AgentAnswer): number => {
  const { orm, now } = context
  if (!answer.model?.trim()) throw refused("name the model that answered (`model`)")
  const { chatKey, span, before } = windowOf(context, id)
  // Asked about: in the window and not a reply the messenger records. One answered earlier may be answered again.
  const askable = new Map(span.filter((row) => Number(row.replied) === 0).map((row) => [row.external_id, row]))
  const order = new Map([...before.reverse(), ...span].map((row, index) => [row.external_id, { index, pk: row.pk }]))
  const seen = new Set<string>()
  const rows = answer.answers.map(({ message, parent, confidence }) => {
    const asked = askable.get(String(message))
    if (!asked) throw refused(`message ${message} is not one this batch asks about`)
    if (seen.has(asked.external_id)) throw refused(`message ${message} is answered twice`)
    seen.add(asked.external_id)
    if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) {
      throw refused(`the confidence for message ${message} is not between 0 and 1`)
    }
    if (parent === null) return { messagePk: asked.pk, parentPk: null, confidence }
    const found = order.get(String(parent))
    if (!found) throw refused(`the parent ${parent} of message ${message} is not in this batch`)
    if (found.index >= (order.get(asked.external_id)?.index ?? -1)) {
      throw refused(`the parent ${parent} of message ${message} is not earlier than it`)
    }
    return { messagePk: asked.pk, parentPk: found.pk, confidence }
  })
  if (rows.length === 0) return 0
  const pks = sql.join(
    rows.map(({ messagePk }) => sql`${messagePk}`),
    sql`, `,
  )
  orm.run(sql`DELETE FROM message_links WHERE source = 'agent' AND message_id IN (${pks})`)
  const at = now()
  for (const row of rows) {
    orm.run(
      sql`INSERT INTO message_links (chat_id, message_id, parent_id, source, kind, confidence, method, version, batch, created_at, updated_at)
        VALUES (${chatKey}, ${row.messagePk}, ${row.parentPk}, 'agent', 'answer', ${row.confidence}, ${answer.model.trim()},
          ${answer.skill ?? null}, ${id}, ${at}, ${at})`,
    )
  }
  return rows.length
}

/** Drops the agent's answers for a chat, or only one model's (A10); messages are never touched. */
export const clearAnswers = ({ orm }: StoreContext, chatKey: number, model: string | undefined): number =>
  Number(
    orm.all<{ n: number }>(
      sql`DELETE FROM message_links WHERE chat_id = ${chatKey} AND source = 'agent'
        ${model === undefined ? sql`` : sql`AND method = ${model}`} RETURNING 1 AS n`,
    ).length,
  )
