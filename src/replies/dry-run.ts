import { CliError } from "@wirecat/cli-base"
import { formatLocator } from "../domain/locator.js"
import type { Chat, Id, Message } from "../domain/models.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { decide } from "./decide.js"
import type { ReplyRender } from "./rendering.js"
import { type Audience, outsideAudience, type ReplyRule } from "./rules.js"
import { emptyState, recordReply } from "./state.js"
import { renderReplyTemplate, type TemplateBlock } from "./template.js"

export const DRY_RUN_DAYS = 7
const PAGE = 500

export interface WouldReply {
  locator: string
  chatId: Id
  chatTitle: string | null
  to: { id: Id; name: string | null }
  at: string
  /** `null`: the rule would send nothing here — it only opens a task, or the audience does not allow the sender. */
  text: string | null
  asReply: boolean
  /** It would open a task for the message. */
  task: boolean
  blocks?: TemplateBlock[]
  reason?: string
}

export interface RuleDryRun {
  id: string
  would: WouldReply[]
  /** How many messages the rule passed over, by the reason it gives. */
  skipped: Record<string, number>
}

export interface DryRun {
  since: string
  until: string
  rules: RuleDryRun[]
  /** Senders the store has no bot flag for; taken as people, as `serve` would have to. */
  botUnknown: number
}

/**
 * What the rules would have answered in the stored messages since `since`, as `serve` would have met
 * them: oldest first, rules in file order, the first that replies wins, the limits counted as it goes.
 * The state starts empty and lives only here, so a run changes no file and sends nothing. A rule that
 * is off is tried as if on: trying it before turning it on is the point.
 */
export const dryRun = async (
  store: MessageStore,
  account: AccountKey,
  rules: ReplyRule[],
  {
    since,
    until = Date.now(),
    only,
    audience,
    render,
  }: {
    since: number
    until?: number
    only?: string
    audience: Audience
    render?: ReplyRender
  },
): Promise<DryRun> => {
  const tried = only === undefined ? rules : rules.filter((rule) => rule.id === only)
  if (only !== undefined && tried.length === 0) {
    throw new CliError("not_found", `no reply rule "${only}" — the rules are: ${rules.map((one) => one.id).join(", ")}`)
  }
  const chats = (await store.chats(account, {})).items.filter((chat) => chat.kind === "dialog" || chat.kind === "group")
  const arrived: { message: Message; chat: Chat }[] = []
  for (const chat of chats) {
    for (const message of await storedSince(store, account, chat.id, since)) {
      if (Date.parse(message.timestamp) <= until) arrived.push({ message, chat })
    }
  }
  arrived.sort((a, b) => Date.parse(a.message.timestamp) - Date.parse(b.message.timestamp))

  const people = await store.people(account.provider, { account: account.account })
  const { isContact, botOf, botFlags } = await senderFacts(store, account)
  const results = tried.map((rule) => ({
    id: rule.id,
    would: [] as WouldReply[],
    skipped: {} as Record<string, number>,
  }))
  let state = emptyState()
  for (const { message, chat } of arrived) {
    const sender = message.senderId
    const isBot = sender === null ? null : await botOf(sender)
    const now = Date.parse(message.timestamp)
    for (const [index, rule] of tried.entries()) {
      const result = results[index] as RuleDryRun
      const decision = decide(
        { ...rule, on: true },
        {
          message,
          chat,
          owner: { id: account.account },
          sender: {
            isBot: isBot === true,
            isContact: sender !== null && isContact(sender),
          },
          outside: outsideAudience(audience, sender, chat.id),
          since,
        },
        state,
        now,
      )
      if ("skip" in decision) {
        result.skipped[decision.skip] = (result.skipped[decision.skip] ?? 0) + 1
        continue
      }
      const rendered =
        decision.reply === null
          ? undefined
          : render
            ? await render(rule, message, chat, now)
            : await renderReplyTemplate(rule.reply, {
                senderName: message.senderName,
                chat,
                now,
                timezone: rule.when.hours?.timezone,
                data: message.text,
                preview: true,
              })
      result.would.push({
        locator: formatLocator({
          provider: account.provider,
          account: account.account,
          chat: chat.id,
          message: message.id,
        }),
        chatId: chat.id,
        chatTitle: chat.title,
        to: { id: sender as Id, name: message.senderName ?? people.get(sender as Id)?.name ?? null },
        at: message.timestamp,
        text: rendered?.text ?? null,
        asReply: decision.reply?.asReply ?? false,
        task: decision.actions.includes("task"),
        ...(rendered?.blocks.length ? { blocks: rendered.blocks } : {}),
        ...(rendered?.reason ? { reason: rendered.reason } : {}),
      })
      if (decision.actions.includes("task") || rendered?.text) state = recordReply(state, rule, message, now)
      break
    }
  }

  const senders = new Set(arrived.map(({ message }) => message.senderId).filter((id): id is Id => id !== null))
  return {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    rules: results,
    botUnknown: [...senders].filter((id) => botFlags.get(id) === null).length,
  }
}

/**
 * What a message does not say about its sender, from the store: a contact is someone with a
 * one-to-one chat, as `contacts list` counts them; `null` when the store has no bot flag.
 */
export const senderFacts = async (store: MessageStore, account: AccountKey) => {
  const contacts = new Set(
    (await store.contacts(account, { order: "recent", limit: Number.MAX_SAFE_INTEGER })).items.map((one) => one.id),
  )
  const botFlags = new Map<Id, boolean | null>()
  const botOf = async (id: Id): Promise<boolean | null> => {
    if (!botFlags.has(id)) {
      const person = await store.personOf({ provider: account.provider, id })
      const own = person?.identities.find((one) => one.provider === account.provider && one.id === id)
      botFlags.set(id, own?.isBot ?? null)
    }
    return botFlags.get(id) ?? null
  }
  return { isContact: (id: Id) => contacts.has(id), botOf, botFlags }
}

const storedSince = async (store: MessageStore, account: AccountKey, chat: Id, since: number): Promise<Message[]> => {
  const found: Message[] = []
  let before: Id | undefined
  while (true) {
    const page = await store.messages(account, chat, {
      limit: PAGE,
      since: new Date(since).toISOString(),
      ...(before === undefined ? {} : { before }),
    })
    found.unshift(...page.items)
    const oldest = page.items[0]
    if (!page.hasMore || oldest === undefined) return found
    before = oldest.id
  }
}
