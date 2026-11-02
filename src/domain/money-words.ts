import type { TaskCategory } from "./task-categories.js"

/**
 * Verb classes for reading money in a chat, matched by stem as task categories are. A stem cannot tell the imperative
 * from the past tense (`оплати`, `оплатил` → `оплат`) or from a promise (`pagué`, `pagaré` → `pag`), so a stem that
 * several classes share is listed once, under the request, and a word only counts where its stem is its own. The
 * signal that reads these keeps the sender's side (owner or other) to decide the direction.
 */
export const MONEY_REQUEST = "money-request"
export const MONEY_DONE = "money-done"
export const PROMISE = "promise"

export const MONEY_WORDS: readonly TaskCategory[] = [
  {
    name: MONEY_REQUEST,
    meaning: "asks for a payment or sends an invoice",
    triggers: {
      en: ["pay", "send", "transfer", "invoice", "owe", "refund", "remit"],
      ru: ["переведи", "оплати", "заплати", "вышли", "отправь", "скинь", "верни", "счёт", "выстави", "должен"],
      es: ["envía", "transfiere", "factura", "debes", "devuelve", "abona"],
    },
  },
  {
    name: MONEY_DONE,
    meaning: "says a payment was made or received",
    triggers: {
      en: ["paid", "sent", "transferred", "received", "refunded", "settled"],
      ru: ["перевёл", "перевела", "выслал", "вернул", "скинул", "получил", "получила"],
      es: ["pagué", "pagado", "recibido"],
    },
  },
  {
    name: PROMISE,
    meaning: "promises to pay or send later",
    triggers: {
      en: ["promise", "promised", "guarantee"],
      ru: ["оплачу", "заплачу", "отправлю", "обещаю", "гарантирую"],
      es: ["prometo", "transferiré", "devolveré"],
    },
  },
]
