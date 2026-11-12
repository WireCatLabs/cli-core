import { CliError } from "@wirecat/cli-base"
import type { Id } from "../../domain/models.js"
import { formatReference } from "../../domain/references.js"
import { isUsable } from "../../domain/relations.js"
import type { AccountKey, MessageStore } from "../../store/store.js"
import { chatCoverage } from "../chat-coverage.js"
import { LINK_PURPOSE, type PurposeConfig, purposeRead, purposesOf } from "../project-purposes.js"
import {
  type ChatCount,
  type ChatCounter,
  canonicalProjectRef,
  type LinkedChat,
  linkedChatsOf,
  storedChatCount,
} from "../stored-project-gathering.js"
import { centsText } from "./signals/amounts.js"
import { STATUS_SIGNALS } from "./signals/index.js"
import type {
  StatusAttention,
  StatusChat,
  StatusChild,
  StatusContext,
  StatusItem,
  StatusProject,
  StatusSignal,
} from "./types.js"

export type * from "./types.js"
export { STATUS_SIGNALS }

const DAY = 86_400_000
/** Messages read per chat; the newest of the window. */
export const STATUS_WINDOW = 300
/** Linked chats read at most, as `projects evidence` reads. */
export const STATUS_CHATS = 16
const CHILD_DEPTH = 2
const CHILDREN = 8

export interface ProjectStatusInput {
  /** An id, key, name or alias, as `canonicalProjectRef` takes it. */
  project: string
  /** tg and max: the profile's own; left out, every account the links name. */
  accounts?: AccountKey[]
  days?: number
  after?: number
  asOf?: number
  contextQueries?: string[]
  /** The chat purposes read; `["all"]` reads every one. Left out, the config's defaults. */
  purposes?: readonly string[]
  /** The host's purposes; core's built-in ones when left out. */
  purposeConfig?: PurposeConfig
  /** How many messages a chat left out by purpose holds in the window; the store's own count when left out. */
  count?: ChatCounter
  /** Default `STATUS_SIGNALS`; tests pass their own. */
  signals?: readonly StatusSignal[]
}

export type StatusChatSummary = Omit<StatusChat, "messages" | "account">

/** A linked chat not read; one left out by its purpose says how much it holds in the window. */
export type OutOfScope =
  | { chat: string; reason: "other-account" | "linked-chat-limit" }
  | ({ chat: string; reason: "purpose"; purpose: string; account: AccountKey; chatId: Id } & ChatCount)

export interface MoneyTotal {
  direction: string
  currency: string | null
  amount: string
  rows: number
}

export interface ProjectStatus {
  project: StatusProject
  children: (StatusProject & { chats: number })[]
  window: { since: string; until: string }
  /** Every account a read chat is in, `provider/account`. */
  accounts: string[]
  chats: StatusChatSummary[]
  /** Every signal's items, in signal order, then chat order. */
  items: StatusItem[]
  /** What confirmed open invoices still owe, summed per direction and currency; never an amount found in words. */
  money: { open: MoneyTotal[] }
  outOfScope: OutOfScope[]
  /** The purposes read: `all`, or the list. */
  purposes: "all" | string[]
  failed: { signal: string; why: string }[]
  /** Chats worth reading next, highest first. */
  attention: StatusAttention[]
  signals: { id: string; version: number }[]
}

export const projectsCatalog = async (store: MessageStore) =>
  new Map(
    (await store.knowledge.vocabulary({ kind: "project" })).entries.map((entry) => [`project:${entry.id}`, entry]),
  )

/** Confirmed `member-of` links from another project; depth two, eight at most, a project seen twice skipped. */
export const childrenOf = async (
  store: MessageStore,
  root: StatusProject,
  catalog: Awaited<ReturnType<typeof projectsCatalog>>,
) => {
  const children: StatusChild[] = []
  const cut: StatusContext["project"]["cut"] = []
  const seen = new Set([root.ref])
  let level = [root.ref]
  for (let depth = 1; level.length > 0; depth++) {
    const below: string[] = []
    for (const parent of level)
      for (const relation of await store.knowledge.relations(null, parent)) {
        if (!isUsable(relation.standing) || relation.kind !== "member-of" || relation.to !== parent) continue
        if (!relation.from.startsWith("project:")) continue
        const ref = relation.from
        const entry = catalog.get(ref)
        if (!entry) continue
        if (seen.has(ref)) {
          if (!cut.some((one) => one.ref === ref) && !children.some((one) => one.ref === ref))
            cut.push({ ref, reason: "cycle" })
          continue
        }
        seen.add(ref)
        if (depth > CHILD_DEPTH) cut.push({ ref, reason: "depth" })
        else if (children.length >= CHILDREN) cut.push({ ref, reason: "limit" })
        else {
          children.push({ ref, key: entry.key, name: entry.name, parent, depth })
          below.push(ref)
        }
      }
    level = below
  }
  return { children, cut }
}

type Link = LinkedChat & { project: string }

export const inAccounts = (accounts: AccountKey[] | undefined, provider: string, account: string) =>
  accounts === undefined || accounts.some((one) => one.provider === provider && one.account === account)

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error))

const owed = (item: StatusItem) => {
  const data = item.data as { state?: string; status?: string }
  return item.signal === "payments" && data.state === "expected" && data.status === "confirmed"
}

const keepsBooks = async (store: MessageStore, projects: string[]) => {
  for (const project of projects) {
    const filter = { project, review: "confirmed" as const, limit: 1 }
    if ((await store.finance.invoices(filter)).items.length || (await store.finance.payments(filter)).items.length)
      return true
  }
  return false
}

const totalsOf = (items: StatusItem[]): MoneyTotal[] => {
  const totals = new Map<string, MoneyTotal & { cents: number }>()
  for (const item of items) {
    const data = item.data as { amount?: string; currency?: string | null; direction?: string }
    if (!owed(item) || data.amount === undefined) continue
    const key = `${data.direction}|${data.currency ?? ""}`
    const total = totals.get(key) ?? {
      direction: data.direction ?? "unknown",
      currency: data.currency ?? null,
      amount: "0.00",
      rows: 0,
      cents: 0,
    }
    total.cents += Math.round(Number(data.amount) * 100)
    total.rows += 1
    totals.set(key, total)
  }
  return [...totals.values()].map(({ cents, ...total }) => ({ ...total, amount: centsText(cents) }))
}

/**
 * Where a project stands, from the store alone: its linked chats and its children's, each read once, then every
 * signal on its own. A signal that fails is named in `failed` and the others still answer. No model call.
 */
export const projectStatus = async (store: MessageStore, input: ProjectStatusInput): Promise<ProjectStatus> => {
  const now = input.asOf ?? Date.now()
  const since = input.after ?? now - (input.days ?? 60) * DAY
  if (!(since < now)) throw new CliError("validation_error", "the window must start before it ends")
  const signals = input.signals ?? STATUS_SIGNALS
  const catalog = await projectsCatalog(store)
  const ref = await canonicalProjectRef(store, input.project)
  const entry = catalog.get(ref)
  if (!entry) throw new CliError("not_found", "the owner project is unavailable")
  const root: StatusProject = { ref, key: entry.key, name: entry.name }
  const purposes = purposesOf(input.purposes, input.purposeConfig, root)
  const count = input.count ?? storedChatCount(store)
  const { children, cut } = await childrenOf(store, root, catalog)

  const outOfScope: ProjectStatus["outOfScope"] = []
  const linked = new Map<string, Link>()
  for (const project of [root, ...children])
    for (const link of await linkedChatsOf(store, project.ref)) {
      const chat = formatReference({ type: "chat", provider: link.provider, account: link.account, chat: link.chat })
      if (!linked.has(chat)) linked.set(chat, { ...link, project: project.ref })
    }
  const chosen: [string, Link][] = []
  for (const [chat, link] of linked) {
    if (!purposeRead(purposes, link.purpose)) {
      const account = { provider: link.provider, account: link.account }
      outOfScope.push({
        chat,
        reason: "purpose",
        purpose: link.purpose ?? LINK_PURPOSE,
        account,
        chatId: link.chat,
        ...(await count(account, link.chat, { since, until: now })),
      })
    } else if (!inAccounts(input.accounts, link.provider, link.account))
      outOfScope.push({ chat, reason: "other-account" })
    else if (chosen.length >= STATUS_CHATS) outOfScope.push({ chat, reason: "linked-chat-limit" })
    else chosen.push([chat, link])
  }

  const sinceIso = new Date(since).toISOString()
  const chats: StatusChat[] = []
  for (const [chat, link] of chosen) {
    const account: AccountKey = { provider: link.provider, account: link.account }
    const [coverage] = await chatCoverage(store, account, [link.chat])
    const page = await store.messages.messages(account, link.chat, { limit: STATUS_WINDOW, since: sinceIso })
    chats.push({
      ref: chat,
      account,
      chatId: link.chat,
      title: coverage?.title ?? null,
      kind: (await store.chats.chatKind(account, link.chat)) ?? "unknown",
      role: link.role,
      purpose: link.purpose ?? LINK_PURPOSE,
      project: link.project,
      coverage: coverage as NonNullable<typeof coverage>,
      messages: page.items.filter((message) => Date.parse(message.timestamp) <= now),
    })
  }

  const context: StatusContext = {
    now,
    since,
    chats,
    project: { ...root, children, cut },
    store,
    books: await keepsBooks(store, [root.ref, ...children.map((child) => child.ref)]),
    contextQueries: input.contextQueries ?? [],
  }
  const items: StatusItem[] = []
  const failed: ProjectStatus["failed"] = []
  const weights = new Map<string, { weight: number; why: string[] }>()
  for (const signal of signals) {
    try {
      const found =
        signal.scope === "chat"
          ? (await Promise.all(chats.map((chat) => signal.read(context, chat)))).flat()
          : await signal.read(context)
      for (const one of signal.attention?.(found, context) ?? []) {
        const held = weights.get(one.chat) ?? { weight: 0, why: [] }
        held.weight += Math.max(0, Math.min(3, one.weight))
        if (!held.why.includes(one.why)) held.why.push(one.why)
        weights.set(one.chat, held)
      }
      for (const one of found) items.push(one)
    } catch (error) {
      failed.push({ signal: signal.id, why: failure(error) })
    }
  }
  const order = new Map(chats.map((chat, index) => [chat.ref, index]))
  const attention = [...weights]
    .filter(([, { weight }]) => weight > 0)
    .map(([chat, { weight, why }]) => ({ chat, weight, why: why.join(", ") }))
    .sort((a, b) => b.weight - a.weight || (order.get(a.chat) ?? 0) - (order.get(b.chat) ?? 0))

  return {
    project: root,
    children: children.map(({ ref, key, name }) => ({
      ref,
      key,
      name,
      chats: chats.filter((chat) => chat.project === ref).length,
    })),
    window: { since: sinceIso, until: new Date(now).toISOString() },
    accounts: [...new Set(chats.map((chat) => `${chat.account.provider}/${chat.account.account}`))],
    chats: chats.map(({ messages: _messages, account: _account, ...chat }) => chat),
    items,
    money: { open: totalsOf(items) },
    outOfScope,
    purposes: purposes === "all" ? "all" : [...purposes],
    failed,
    attention,
    signals: signals.map(({ id, version }) => ({ id, version })),
  }
}
