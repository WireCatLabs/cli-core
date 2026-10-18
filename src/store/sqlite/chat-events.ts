import type { ChatEvent, Provider } from "../../domain/models.js"
import { identityPk } from "./identities.js"
import type { StoreContext } from "./open.js"
import { toMs } from "./values.js"

/** A replay of an event the chat already holds keeps the stored row and adds any person it lacked. */
export const saveChatEvents = (
  context: StoreContext,
  accountKey: number,
  provider: Provider,
  chatKey: number,
  events: ChatEvent[],
): void => {
  const { database, now } = context
  const insert = database.prepare(
    `INSERT INTO chat_events (chat_id, source_id, action, actor_identity_id, title, happened_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (chat_id, source_id) DO NOTHING`,
  )
  const held = database.prepare("SELECT id FROM chat_events WHERE chat_id = ? AND source_id = ?")
  const person = database.prepare("INSERT OR IGNORE INTO chat_event_people (chat_event_id, identity_id) VALUES (?, ?)")
  const pk = ({ id, name }: { id: string; name: string | null }) => identityPk(context, accountKey, provider, id, name)
  for (const event of events) {
    const actor = event.by.id === null ? null : pk({ id: event.by.id, name: event.by.name })
    const at = toMs(event.timestamp) ?? now()
    insert.run(chatKey, event.messageId, event.event, actor, event.title ?? null, at, now(), now())
    const id = Number(held.get(chatKey, event.messageId)?.id)
    for (const one of event.people) person.run(id, pk(one))
  }
}

/** Oldest first, from `since` (ms); the newest `limit` when there are more. */
export const chatEventsOf = (
  { database }: StoreContext,
  chatKey: number,
  { since = 0, limit }: { since?: number; limit?: number },
): ChatEvent[] => {
  const rows = database
    .prepare(
      `SELECT e.id, e.source_id AS sourceId, e.action, e.title, e.happened_at AS at, a.external_id AS actorId,
              a.name AS actorName
       FROM chat_events e LEFT JOIN identities a ON a.id = e.actor_identity_id
       WHERE e.chat_id = ? AND e.happened_at >= ?
       ORDER BY e.happened_at DESC, e.id DESC LIMIT ?`,
    )
    .all(chatKey, since, limit ?? -1) as {
    id: number
    sourceId: string
    action: string
    title: string | null
    at: number
    actorId: string | null
    actorName: string | null
  }[]
  const people = new Map<number, ChatEvent["people"]>()
  const named = database
    .prepare(
      `SELECT p.chat_event_id AS event, i.external_id AS id, i.name FROM chat_event_people p
       JOIN identities i ON i.id = p.identity_id
       WHERE p.chat_event_id IN (SELECT value FROM json_each(?)) ORDER BY i.external_id`,
    )
    .all(JSON.stringify(rows.map(({ id }) => id))) as { event: number; id: string; name: string | null }[]
  for (const { event, id, name } of named) people.set(event, [...(people.get(event) ?? []), { id, name }])
  return rows.reverse().map(({ id, sourceId, action, title, at, actorId, actorName }) => ({
    messageId: sourceId,
    timestamp: new Date(at).toISOString(),
    event: action,
    by: { id: actorId, name: actorName },
    people: people.get(id) ?? [],
    ...(title === null ? {} : { title }),
  }))
}
