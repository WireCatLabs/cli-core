import type { Id } from "../domain/models.js"
import type { HistoryBatch } from "../ports/messenger.js"

/** How much pushed history the store keeps of each kind of chat. */
export interface HistoryLimits {
  /** One-to-one chats: days back from now. */
  dialogDays: number
  /** Groups of more than two people: days back from now. */
  groupDays: number
  /** Above this many people a group's pushed history is not kept at all. */
  groupMembersMax: number
}

export const HISTORY_MAX_DAYS = 1095

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = { dialogDays: 1095, groupDays: 365, groupMembersMax: 50 }

export type HistorySkipReason = "group_too_large" | "older_than_window"

/** What the limits left out of one chat, summed over every push. */
export interface HistorySkip {
  reason: HistorySkipReason
  messages: number
  oldestAt: string
  newestAt: string
  /** For `group_too_large`: how many people the group had. */
  members?: number
  /** For `older_than_window`: the window's start when the push was saved. */
  keptFrom?: string
}

/** The kind and size of a chat, as the batch names it or the store holds it. */
export interface ChatShape {
  kind: string
  participantsCount: number | null
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Whether this chat's pushed history is kept, and from when. A chat the owner lifted keeps everything. */
export const historyWindow = (
  shape: ChatShape | undefined,
  limits: HistoryLimits,
  now: number,
): { keepFrom: number } | { skip: "group_too_large"; members: number } => {
  const group = shape !== undefined && shape.kind !== "dialog" && shape.kind !== "saved"
  if (group && (shape.participantsCount ?? 0) > limits.groupMembersMax)
    return { skip: "group_too_large", members: shape.participantsCount ?? 0 }
  const days = group ? limits.groupDays : limits.dialogDays
  return { keepFrom: now - Math.min(days, HISTORY_MAX_DAYS) * DAY_MS }
}

/**
 * The batch without the messages its chats' limits leave out, and what was left out per chat. Chat rows, people and
 * re-keys always stay: a skipped chat is still listed, so its history can be fetched by hand.
 */
export const limitBatch = (
  batch: HistoryBatch,
  shapes: (chatId: Id) => ChatShape | undefined,
  included: (chatId: Id) => boolean,
  limits: HistoryLimits,
  now = Date.now(),
): { batch: HistoryBatch; skipped: Map<Id, HistorySkip> } => {
  const skipped = new Map<Id, HistorySkip>()
  if (!batch.messages?.length) return { batch, skipped }
  const named = new Map((batch.chats ?? []).map((chat) => [chat.id, chat]))
  const windows = new Map<Id, ReturnType<typeof historyWindow> | undefined>()
  const windowOf = (chatId: Id) => {
    if (!windows.has(chatId)) {
      const chat = named.get(chatId)
      const shape = chat ? { kind: chat.kind, participantsCount: chat.participantsCount ?? null } : shapes(chatId)
      windows.set(chatId, included(chatId) ? undefined : historyWindow(shape, limits, now))
    }
    return windows.get(chatId)
  }
  const messages = batch.messages.filter((message) => {
    const window = windowOf(message.chatId)
    if (window === undefined) return true
    const at = Date.parse(message.timestamp)
    if ("keepFrom" in window && !(at < window.keepFrom)) return true
    const reason: HistorySkipReason = "skip" in window ? window.skip : "older_than_window"
    const held = skipped.get(message.chatId)
    const iso = new Date(at).toISOString()
    skipped.set(message.chatId, {
      reason,
      messages: (held?.messages ?? 0) + 1,
      oldestAt: held && held.oldestAt < iso ? held.oldestAt : iso,
      newestAt: held && held.newestAt > iso ? held.newestAt : iso,
      ...("skip" in window ? { members: window.members } : { keptFrom: new Date(window.keepFrom).toISOString() }),
    })
    return false
  })
  return { batch: { ...batch, messages }, skipped }
}
