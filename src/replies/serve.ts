import type { Id, Message } from "../domain/models.js"
import type { Warn } from "../runs/events.js"
import { codeOf } from "../sends/guarded.js"
import { decide } from "./decide.js"
import type { ReplyChat, ReplyRender } from "./rendering.js"
import { outsideAudience, readReplies } from "./rules.js"
import { readRepliesState, recordReply, writeRepliesState } from "./state.js"
import { renderReplyTemplate, templateWarning } from "./template.js"

export const NOT_ALLOWED = "replies.send is not allow"
export const NO_RULES = "no rules"
export const ONLY_TASK = "opened a task, sent nothing"
export const NO_TASKS = "this serve cannot open tasks"

/** `task`: the rule that opened a task for the message — beside a reply, or beside why none went. */
export type Replied = { sent: string; task?: string } | { skip: string; task?: string }

export interface Replier {
  /** The profile's rules and state files, read on every message so an edit or `replies pause` applies at once. */
  rulesPath: string
  statePath: string
  provider: string
  owner: { id: Id | null; username?: string }
  /** ms: when `serve` began; what is older came in the catch-up and is never answered. */
  since: number
  /** Whether the profile's `replies.send` is `allow`. `ask` is no: `serve` has nobody to ask. */
  allowed: () => boolean
  chatOf: (chat: Id) => Promise<ReplyChat>
  render?: ReplyRender
  warn?: Warn
  senderOf: (person: Id) => Promise<{ isBot: boolean; isContact: boolean }>
  send: (reply: { chat: Id; text: string; replyTo?: Id; sendId: string; origin: string }) => Promise<unknown>
  newSendId: () => string
  /** A rule's `task` action: a `request` task for the message; `false` when the message already had one. */
  openTask?: (message: Message, origin: string) => Promise<boolean>
  now?: () => number
}

/** Refusals that a second try with the same id would only repeat. */
const FINAL = new Set(["permission_error", "confirmation_required", "rate_limited", "validation_error", "not_found"])

/**
 * One arriving message through the rules, in file order, the first that matches acting: a task opens
 * for anyone (NEED-582), a reply goes only to a sender the file's audience allows and only with
 * `replies.send` at `allow`. A send that fails is
 * tried once more with the same send id, so the messenger delivers at most one; a message whose
 * reply may have gone is kept as answered.
 */
export const replyTo = async (deps: Replier, message: Message): Promise<Replied> => {
  const { rules, audience } = readReplies(deps.rulesPath, deps.provider)
  if (rules.length === 0) return { skip: NO_RULES }
  let state = readRepliesState(deps.statePath)
  const now = deps.now?.() ?? Date.now()
  const outside = outsideAudience(audience, message.senderId, message.chatId)
  // Asked only where a rule may act: for a sender the audience allows, or when a rule opens tasks for anyone.
  const looks = outside === null || rules.some((rule) => rule.on && rule.do.includes("task"))
  const chat = looks ? await deps.chatOf(message.chatId) : { id: message.chatId, kind: "unknown" as const }
  const facts =
    looks && message.senderId !== null ? await deps.senderOf(message.senderId) : { isBot: false, isContact: false }
  const incoming = {
    message,
    chat,
    owner: deps.owner,
    sender: facts,
    outside,
    since: deps.since,
  }

  let why = "no rule matched"
  for (const rule of rules) {
    const decision = decide(rule, incoming, state, now)
    if ("skip" in decision) {
      why = decision.skip
      continue
    }
    const origin = `rule:${rule.id}`
    let task: string | undefined
    if (decision.actions.includes("task")) {
      if (deps.openTask) {
        await deps.openTask(message, origin)
        task = rule.id
      } else if (decision.reply === null) return { skip: NO_TASKS }
    }
    const opened = task === undefined ? {} : { task }
    if (decision.reply === null) {
      writeRepliesState(deps.statePath, recordReply(readRepliesState(deps.statePath), rule, message, now))
      return { skip: ONLY_TASK, ...opened }
    }
    if (!deps.allowed()) return { skip: NOT_ALLOWED, ...opened }
    const rendered = deps.render
      ? await deps.render(rule, message, chat, now)
      : await renderReplyTemplate(rule.reply, {
          senderName: message.senderName,
          chat,
          now,
          timezone: rule.when.hours?.timezone,
          data: message.text,
        })
    for (const warning of rendered.warnings) deps.warn?.(warning, templateWarning(warning))
    if (rendered.text === null) return { skip: rendered.reason ?? "reply template produced no reply", ...opened }
    // Pause and consent can be revoked while an async model request is in flight.
    if (readRepliesState(deps.statePath).paused || !deps.allowed())
      return { skip: "replies paused or permission revoked during rendering", ...opened }
    const fresh = readReplies(deps.rulesPath, deps.provider)
    if (
      JSON.stringify(fresh.rules.find((one) => one.id === rule.id)) !== JSON.stringify(rule) ||
      outsideAudience(fresh.audience, message.senderId, message.chatId)
    ) {
      return { skip: "reply rule or audience changed during rendering", ...opened }
    }
    const sendId = deps.newSendId()
    const reply = {
      chat: message.chatId,
      text: rendered.text,
      ...(decision.reply.asReply ? { replyTo: message.id } : {}),
      sendId,
      origin,
    }
    let failed: unknown
    try {
      await deps.send(reply)
    } catch (error) {
      if (FINAL.has(codeOf(error))) return { skip: codeOf(error), ...opened }
      try {
        await deps.send(reply)
      } catch (again) {
        failed = again
      }
    }
    state = recordReply(readRepliesState(deps.statePath), rule, message, now)
    writeRepliesState(deps.statePath, state)
    if (failed !== undefined) throw failed
    return { sent: rule.id, ...opened }
  }
  return { skip: why }
}
