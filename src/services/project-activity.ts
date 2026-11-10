import { CliError } from "@wirecat/cli-base"
import { formatReference } from "../domain/references.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { childrenOf, inAccounts, projectsCatalog } from "./project-status/index.js"
import { type LinkedChat, linkedChatsOf } from "./stored-project-gathering.js"

export interface ProjectActivityInput {
  since: number
  /** Exclusive; now when left out. */
  until?: number
  /** Only chats of these accounts count, as under a group lock; every account when left out. */
  accounts?: AccountKey[]
  limit: number
  offset: number
  /** The busiest chats named per project. */
  top?: number
}

export interface ProjectActivityChat {
  ref: string
  title: string | null
  messages: number
}

export interface ProjectActivity {
  ref: string
  key: string | null
  name: string
  /** Chats linked to the project or its child projects, confirmed, in the accounts read. */
  chats: number
  /** Of them, muted now: their messages are not counted. */
  muted: number
  messages: number
  /** Of `messages`, the owner's. */
  sent: number
  /** The newest message of an unmuted linked chat, in or before the window. */
  lastAt: string | null
  top: ProjectActivityChat[]
  /** Some child projects were past the depth or count `projects status` reads, so their chats are not counted. */
  partial: boolean
}

export interface ProjectActivities {
  items: ProjectActivity[]
  total: number
  hasMore: boolean
}

const TOP = 3

/**
 * Every project's linked chats and how busy they were, in one pass: every confirmed link of the project and its
 * children, any purpose and with no chat limit (`projects status` caps both), counted by when each message was sent. A
 * muted chat is named in `muted` and left out of the counts, as everywhere the owner's activity is counted.
 */
export const projectActivity = async (store: MessageStore, input: ProjectActivityInput): Promise<ProjectActivities> => {
  const until = input.until ?? Date.now()
  if (!(input.since < until)) throw new CliError("validation_error", "the window must start before it ends")
  const whole = (n: number | undefined) => n === undefined || (Number.isInteger(n) && n >= 0)
  if (!(input.limit >= 1 && whole(input.limit) && whole(input.offset) && whole(input.top)))
    throw new CliError("validation_error", "limit must be at least 1; offset and top whole numbers from 0")
  const catalog = await projectsCatalog(store)
  const linked: { project: string; key: string | null; name: string; chats: LinkedChat[]; partial: boolean }[] = []
  for (const [ref, entry] of catalog) {
    const root = { ref, key: entry.key ?? null, name: entry.name }
    const { children, cut } = await childrenOf(store, root, catalog)
    const chats = new Map<string, LinkedChat>()
    for (const project of [root, ...children])
      for (const link of await linkedChatsOf(store, project.ref)) {
        if (!inAccounts(input.accounts, link.provider, link.account)) continue
        chats.set(refOf(link), link)
      }
    linked.push({
      project: ref,
      key: root.key,
      name: root.name,
      chats: [...chats.values()],
      partial: cut.some((one) => one.reason !== "cycle"),
    })
  }

  const unique = new Map(linked.flatMap(({ chats }) => chats.map((chat) => [refOf(chat), chat] as const)))
  const asked = [...unique.values()]
  const counts = await store.messages.chatActivityCounts(
    asked.map((chat) => ({ account: { provider: chat.provider, account: chat.account }, chatId: chat.chat })),
    { since: input.since, until, now: Date.now() },
  )
  const countOf = new Map(asked.map((chat, index) => [refOf(chat), counts[index]]))

  const all = linked.map(({ project, key, name, chats, partial }): ProjectActivity => {
    const known = chats.flatMap((chat) => {
      const count = countOf.get(refOf(chat))
      return count ? [{ ref: refOf(chat), ...count }] : []
    })
    const counted = known.filter((chat) => !chat.muted)
    const last = counted.map((chat) => chat.lastAt).filter((at) => at !== null)
    return {
      ref: project,
      key,
      name,
      chats: chats.length,
      muted: known.length - counted.length,
      messages: counted.reduce((sum, chat) => sum + chat.messages, 0),
      sent: counted.reduce((sum, chat) => sum + chat.sent, 0),
      lastAt: last.sort().at(-1) ?? null,
      top: counted
        .filter((chat) => chat.messages > 0)
        .sort((a, b) => b.messages - a.messages || a.ref.localeCompare(b.ref, undefined, { numeric: true }))
        .slice(0, input.top ?? TOP)
        .map(({ ref, title, messages }) => ({ ref, title, messages })),
      partial,
    }
  })
  all.sort(
    (a, b) =>
      b.messages - a.messages ||
      (b.lastAt ?? "").localeCompare(a.lastAt ?? "") ||
      b.chats - a.chats ||
      a.ref.localeCompare(b.ref, undefined, { numeric: true }),
  )
  return {
    items: all.slice(input.offset, input.offset + input.limit),
    total: all.length,
    hasMore: input.offset + input.limit < all.length,
  }
}

const refOf = (chat: LinkedChat) =>
  formatReference({ type: "chat", provider: chat.provider, account: chat.account, chat: chat.chat })
