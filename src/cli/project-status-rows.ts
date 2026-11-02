import type { RowColumn, RowShape } from "./compact.js"

const where: RowColumn[] = [{ field: "ref" }, { field: ["chat_title", "chat"] }]
const who: RowColumn = { field: ["who.owner", "who.name"], tag: "you" }

/**
 * The compact row of each status signal's items, by `status.<signal id>`; a signal's file and its row are the two
 * places a new signal touches. They live here because a service may not import the CLI's row type.
 */
export const STATUS_SIGNAL_ROWS: Readonly<Record<string, RowShape>> = {
  "status.last-message": { columns: [...where, { field: "at", as: "time" }, who] },
  "status.reply-next": {
    columns: [
      ...where,
      { field: "data.next" },
      { field: "data.addressed.name" },
      { field: "data.waiting_since", as: "day" },
      { field: "data.overdue", tag: "overdue" },
    ],
  },
  "status.questions": {
    columns: [...where, { field: "at", as: "day" }, { field: "data.side" }, who],
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
    text: ["data.statement"],
  },
  "status.topics": {
    columns: [
      ...where,
      { field: "data.topic" },
      { field: "data.theirs_last", as: "day" },
      { field: "data.yours_last", as: "day" },
      { field: "data.silent_since", as: "day" },
    ],
  },
  "status.coverage": {
    columns: [
      { field: "chat" },
      { field: "chat_title" },
      { field: "data.state" },
      { field: "data.held.messages", as: "count", tag: "held" },
      { field: "data.held.oldest_at", as: "day" },
      { field: "sync_command" },
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
      { field: "kind" },
      { field: "role" },
      { field: "attention", as: "count", tag: "attention" },
      { field: "why" },
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
  "status.signal": { columns: [{ field: "id" }, { field: "version" }] },
  "status.out-of-scope": { columns: [{ field: "chat" }, { field: "reason" }, { field: "purpose" }] },
  "status.failed": { columns: [{ field: "signal" }], text: ["why"] },
}
