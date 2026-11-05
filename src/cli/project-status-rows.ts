import type { RowColumn, RowShape } from "./compact.js"

const where: RowColumn[] = [{ field: "ref" }]
const who: RowColumn = { field: ["who.owner", "who.name"], tag: "you" }

/** Signals of one item per chat, drawn on the chat's row rather than as a list of their own. */
export const ON_CHAT_ROW: ReadonlySet<string> = new Set(["reply-next", "coverage"])

/**
 * The compact row of each listed status signal's items, by `status.<signal id>`; a signal's file and its row are the
 * two places a new signal touches. They live here because a service may not import the CLI's row type.
 */
export const STATUS_SIGNAL_ROWS: Readonly<Record<string, RowShape>> = {
  "status.questions": {
    columns: [...where, { field: "at", as: "day" }, who],
    text: ["data.excerpt"],
  },
  "status.promises": {
    columns: [
      ...where,
      { field: "at", as: "day" },
      { field: "data.source" },
      { field: "data.side" },
      { field: "data.due", as: "day" },
      { field: "data.status" },
    ],
    text: ["data.title"],
  },
  "status.amounts": {
    columns: [
      ...where,
      { field: "data.direction" },
      { field: "data.amount" },
      { field: "data.currency" },
      { field: "data.state" },
      { field: "data.since", as: "day" },
      { field: "data.asks", as: "count", tag: "asks" },
      { field: "basis" },
    ],
  },
  "status.payments": {
    columns: [{ field: "ref" }, { field: "at", as: "day" }, { field: "data.status" }],
    text: ["data.title"],
  },
  "status.topics": {
    columns: [
      ...where,
      { field: "data.query" },
      { field: "data.yours_last", as: "day" },
      { field: "data.silent_since", as: "day" },
    ],
  },
  "status.children": {
    columns: [
      { field: "data.child" },
      { field: "data.key" },
      { field: "data.name" },
      { field: "data.chats", as: "count", tag: "chats" },
      { field: "data.cut" },
    ],
  },
}

/** The rest of a `project_status` answer: its chats, open money, chats left out, and failed signals. */
export const STATUS_ROWS: Readonly<Record<string, RowShape>> = {
  ...STATUS_SIGNAL_ROWS,
  "status.chat": {
    columns: [
      { field: "chat" },
      { field: "title" },
      { field: "role" },
      { field: "next", prefix: "next" },
      { field: "addressed.name" },
      { field: "waiting_since", as: "day" },
      { field: "overdue", tag: "overdue" },
      { field: "held.messages", as: "count", tag: "held" },
      { field: "unlisted.questions", as: "count", tag: "questions unlisted" },
      { field: "unlisted.promises", as: "count", tag: "promises unlisted" },
    ],
  },
  "status.money": {
    columns: [
      { field: "direction" },
      { field: "amount" },
      { field: "currency" },
      { field: "rows", as: "count", tag: "rows" },
    ],
  },
  "status.out-of-scope": {
    columns: [
      { field: "chat" },
      { field: "reason" },
      { field: "purpose" },
      { field: "messages", as: "count", tag: "messages" },
      { field: "first_at", as: "day" },
      { field: "last_at", as: "day" },
      { field: "read_command" },
    ],
  },
  "status.failed": { columns: [{ field: "signal" }], text: ["why"] },
}
