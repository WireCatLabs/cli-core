import type { Message } from "../../../domain/models.js"
import { MONEY_DONE, MONEY_REQUEST } from "../../../domain/money-words.js"
import { MONEY_DONE_FORMS } from "../../../domain/status-words.js"
import { DEFAULT_TASK_CATEGORIES } from "../../../domain/task-categories.js"
import { amountsOf } from "../../../search/task-signature.js"
import { moneyClassesOf } from "../../money-words.js"
import { listsHit } from "../../task-categories.js"
import { evidenceOf, fromOwner, whoOf } from "../items.js"
import type { StatusChat, StatusItem, StatusSignal } from "../types.js"

export type MoneyDirection = "to_us" | "from_us" | "unknown"

export interface AmountsData {
  /** Decimal as text, two places: money is never a float. */
  amount: string
  currency: string | null
  direction: MoneyDirection
  /** `paid-mentioned` is a message saying so, never a payment the owner recorded. */
  state: "open" | "paid-mentioned" | "mentioned"
  /** The first ask, or the first mention when nobody asked. */
  since: string
  lastAsked: string | null
  asks: number
}

const MONEY = DEFAULT_TASK_CATEGORIES.filter((category) => category.name === "money")

type Verb = "request" | "done" | "none"

// Past forms first: their stem is also a request's (`оплатил` and `оплати` → `оплат`).
const verbOf = (text: string): Verb => {
  if (MONEY_DONE_FORMS.test(text)) return "done"
  const classes = moneyClassesOf(text)
  if (classes.includes(MONEY_DONE)) return "done"
  return classes.includes(MONEY_REQUEST) ? "request" : "none"
}

const roleDirection = (role: string | null): MoneyDirection => {
  const named = role?.trim().toLowerCase()
  return named === "client" ? "to_us" : named === "contractor" ? "from_us" : "unknown"
}

/** The sender's side decides: a stem cannot tell an ask from a report, so who wrote it is the evidence. */
const directionOf = (verb: Verb, owner: boolean, role: string | null): MoneyDirection => {
  if (verb === "request") return owner ? "to_us" : "from_us"
  if (verb === "done") return owner ? "from_us" : "to_us"
  return roleDirection(role)
}

interface Row {
  message: Message
  cents: number
  currency: string | null
  verb: Verb
  direction: MoneyDirection
}

const rowsOf = (chat: StatusChat): Row[] =>
  chat.messages.flatMap((message) => {
    const found = amountsOf(message.text)
    if (!found.length) return []
    const verb = verbOf(message.text)
    if (verb === "none" && !listsHit(message.text, MONEY).length) return []
    const direction = directionOf(verb, fromOwner(message), chat.role)
    return found.map(({ value, currency }) => ({
      message,
      cents: Math.round(value * 100),
      currency,
      verb,
      direction,
    }))
  })

export const centsText = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`

/**
 * Every message with an amount and a money word, folded by amount and currency per chat: the first ask is `since`, a
 * later "paid" message naming the same amount makes it `paid-mentioned`. Instalments are not summed into a total.
 * Nothing when the project keeps books: a word match also finds the owner's quotes and prices, which owe nothing.
 */
export const amounts: StatusSignal<AmountsData> = {
  id: "amounts",
  version: 2,
  scope: "chat",
  read: async (context, chat) => {
    if (!chat || context.books) return []
    const groups = new Map<string, Row[]>()
    for (const row of rowsOf(chat)) {
      const key = `${row.cents}|${row.currency ?? ""}`
      groups.set(key, [...(groups.get(key) ?? []), row])
    }
    return [...groups.values()].map((rows): StatusItem<AmountsData> => {
      const asks = rows.filter((row) => row.verb === "request")
      const done = rows.filter((row) => row.verb === "done")
      const lastAsk = asks.at(-1)
      const first = (asks[0] ?? done[0] ?? rows[0]) as Row
      const paidAfter = done.some(
        (row) => !lastAsk || Date.parse(row.message.timestamp) >= Date.parse(lastAsk.message.timestamp),
      )
      const state = asks.length ? (paidAfter ? "paid-mentioned" : "open") : done.length ? "paid-mentioned" : "mentioned"
      const cited = asks.length ? [...asks, ...(paidAfter ? done.slice(-1) : [])] : rows
      return {
        signal: "amounts",
        chat: chat.ref,
        at: first.message.timestamp,
        who: whoOf(first.message),
        evidence: evidenceOf(chat, ...new Set(cited.map((row) => row.message))),
        basis: "pattern",
        data: {
          amount: centsText(first.cents),
          currency: first.currency,
          direction: first.direction,
          state,
          since: first.message.timestamp,
          lastAsked: lastAsk?.message.timestamp ?? null,
          asks: asks.length,
        },
      }
    })
  },
  attention: (items) =>
    items.flatMap((item) =>
      item.chat !== null && item.data.state === "open" ? [{ chat: item.chat, weight: 2, why: "money open" }] : [],
    ),
}
