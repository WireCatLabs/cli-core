import { CliError } from "@wirecat/cli-base"
import type { ContextSource } from "../context/evidence.js"
import { formatReference, parseReference } from "../domain/references.js"
import { isUsable } from "../domain/relations.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { chatCoverage } from "./chat-coverage.js"
import { gatherProjectEvidence, type ProjectChatFetcher, type ProjectGatheringPorts } from "./project-gathering.js"
import { storedNeighbours } from "./project-gathering-around.js"
import { type EvidenceMentions, findEvidenceMentions } from "./project-gathering-mentions.js"
import { LINK_PURPOSE, type PurposeConfig, purposeRead, purposesOf } from "./project-purposes.js"

export interface StoredProjectInput {
  project: string
  /** The sources the host resolved from its `--source`, and those it could not read. */
  sources: {
    sources: ContextSource[]
    unread: { source: string; kind: string; reason?: "unknown-provider" | "out-of-scope" }[]
    scope: "explicit" | "all-connected"
  }
  aliases?: string[]
  keywords?: string[]
  people?: string[]
  days?: number
  after?: number
  asOf?: number
  checkpoint?: string
  maxReads?: number
  limit?: number
  catchUp?: boolean
  beforeN?: number
  afterN?: number
  /** Syncs the linked chats the store does not hold for the window before reading; off when left out. */
  fetcher?: ProjectChatFetcher
  maxFetchMs?: number
  onFetchProgress?: ProjectGatheringPorts["onFetchProgress"]
  signal?: AbortSignal
  /** The linked chats' purposes to read; `["all"]` reads every one. Left out, the config's defaults. */
  purposes?: readonly string[]
  /** The host's purposes; core's built-in ones when left out. */
  purposeConfig?: PurposeConfig
  /** Proposed `member-of` links count as linked chats and members too, after the confirmed ones, every item marked. */
  includeProposed?: boolean
  /** How many messages a left-out chat holds in the window; the store's own count when left out. */
  count?: ChatCounter
}

export interface ChatCount {
  messages: number
  firstAt: string | null
  lastAt: string | null
}

export type ChatCounter = (
  account: AccountKey,
  chatId: string,
  window: { since: number; until: number },
) => Promise<ChatCount>

/** The store's count of one chat's messages in a window, `until` exclusive, and the first and last of them. */
export const storedChatCount =
  (store: MessageStore): ChatCounter =>
  async (account, chatId, { since, until }) => {
    const window = { since: new Date(since).toISOString(), until: new Date(until - 1).toISOString() }
    const [messages, newest, oldest] = await Promise.all([
      store.messages.countMessages(account, chatId, window),
      store.messages.messages(account, chatId, { limit: 1, since: window.since, until: until - 1 }),
      store.messages.messages(account, chatId, { limit: 1, after: { time: since - 1 }, until: until - 1 }),
    ])
    return {
      messages,
      firstAt: oldest.items[0]?.timestamp ?? null,
      lastAt: newest.items.at(-1)?.timestamp ?? null,
    }
  }

const PROJECT_ID = /^project:[1-9]\d*$/

/** `project:<id>`, or the one project a key, name or alias names; several or none is refused, never guessed. */
export const canonicalProjectRef = async (store: MessageStore, reference: string): Promise<string> => {
  if (PROJECT_ID.test(reference)) {
    const catalog = await store.knowledge.vocabulary({ kind: "project" })
    if (!catalog.entries.some((entry) => entry.id === reference.slice(8)))
      throw new CliError("not_found", "the owner project is unavailable")
    return reference
  }
  const found = await store.knowledge.resolveVocabulary(reference, { kind: "project" })
  const [entry] = found.matches
  if (found.matches.length !== 1 || !entry)
    throw new CliError(
      found.matches.length ? "validation_error" : "not_found",
      found.matches.length
        ? `${reference} names ${found.matches.length} projects; give one by its key or project:<id>`
        : `no project ${reference}`,
      { candidates: found.matches.map((one) => ({ id: one.id, key: one.key, name: one.name })) },
    )
  return `project:${entry.id}`
}

/**
 * An existing project brings its name and aliases; any other name is gathered as given. An id that names no
 * project, or a name that matches several, is refused rather than guessed.
 */
const projectOf = async (store: MessageStore, reference: string) => {
  const id = /^(project:)?[1-9]\d*$/.test(reference)
  let ref: string
  try {
    ref = await canonicalProjectRef(store, id && !reference.startsWith("project:") ? `project:${reference}` : reference)
  } catch (error) {
    if (!id && error instanceof CliError && error.code === "not_found")
      return { ref: null, name: reference, key: null, aliases: [] }
    throw error
  }
  const entry = (await store.knowledge.vocabulary({ kind: "project" })).entries.find((one) => one.id === ref.slice(8))
  if (!entry) throw new CliError("not_found", "the owner project is unavailable")
  return { ref, name: entry.name, key: entry.key, aliases: entry.aliases.map((alias) => alias.name) }
}

/** `person:me` as the owner's `person:<uid>`; any other reference as written. */
const withOwner = async (store: MessageStore, reference: string): Promise<string> => {
  if (reference.trim() !== "person:me") return reference
  const owner = await store.people.owner()
  if (owner === undefined || owner.identities.length === 0)
    throw new CliError(
      "not_found",
      "person:me: no person is marked as you in the store; mark yours with `<messenger> <profile> contacts link <your id> me`",
      { reason: "person.no-owner" },
    )
  return `person:${owner.uid}`
}

interface Contact {
  name?: string
  reference?: string
  senders?: { provider: string; id: string }[]
}

const sendersOf = (person: { identities: { provider: string; id: string | number }[] }) =>
  person.identities.map((identity) => ({ provider: identity.provider, id: String(identity.id) }))

/**
 * A `person:<id>` is read by what their stored identities wrote, and searched only by the short names the owner gave
 * them: their stored name is a messenger display name («Степа Stefan Grachev AVITO M A») that no message spells out.
 * Any other text is a name.
 */
const contactOf = async (store: MessageStore, contact: string): Promise<Contact[]> => {
  const reference = await withOwner(store, contact)
  if (!reference.startsWith("person:")) return [{ name: contact }]
  const person = await store.people.personByUid(reference.slice("person:".length))
  if (!person) throw new CliError("not_found", `no person ${contact}`, { param: "contact" })
  const senders = sendersOf(person)
  const aliases = new Set<string>()
  for (const identity of person.identities)
    for (const account of identity.accounts) {
      const alias = await store.people
        .privateContact({ provider: identity.provider, account }, identity.id)
        .then((one) => one.alias)
        .catch((error) => {
          if (error instanceof CliError && error.code === "not_found") return null
          throw error
        })
      if (alias) aliases.add(alias)
    }
  if (!senders.length && !aliases.size)
    throw new CliError(
      "validation_error",
      `${contact} has no stored identity or alias to search by; pass a name the texts use to --contact`,
      { param: "contact" },
    )
  const names = [...aliases].map((name) => ({ name, reference: contact }))
  return senders.length ? [{ reference: contact, senders }, ...names] : names
}

const LINKED_CHATS = 16
const CORE_LIMIT = 16

interface Proposed {
  from: string
  /** The inbox id: a stored proposal's number, or `link:<id>` for a suggestion written before proposals were. */
  id: string
  role: string | null
  purpose: string | null
  score?: number
}

/** Pending `member-of` proposals to the project, oldest first, so a cut at a limit always drops the same ones. */
const proposedLinksOf = async (store: MessageStore, project: string): Promise<Proposed[]> => {
  const stored = await store.proposedActions.list({ kinds: ["relationship"], status: "proposed", project, limit: 500 })
  const proposals = stored
    .flatMap((action): Proposed[] => {
      const payload = action.payload as { from?: unknown; to?: unknown; kind?: unknown; role?: unknown }
      const { purpose, score } = action.payload as { purpose?: unknown; score?: unknown }
      if (payload?.kind !== "member-of" || payload.to !== project || typeof payload.from !== "string") return []
      return [
        {
          from: payload.from,
          id: action.id,
          role: typeof payload.role === "string" ? payload.role : null,
          purpose: typeof purpose === "string" ? purpose : null,
          ...(typeof score === "number" ? { score } : {}),
        },
      ]
    })
    .sort((a, b) => Number(a.id) - Number(b.id))
  const legacy = (await store.knowledge.relations(null, project))
    .filter((one) => one.standing === "proposed" && one.kind === "member-of" && one.to === project)
    .map((one) => ({ from: one.from, id: `link:${one.id}`, role: one.role, purpose: one.purpose }))
  return [...proposals, ...legacy]
}

export interface ProjectMember {
  person: string
  state: "read" | "member-limit" | "no-identity"
  /** The proposal that names this person a member; read only with `includeProposed`. */
  proposed?: string
  score?: number
}

/** Confirmed `person` members in a stable order, then proposed ones when asked, so a cut drops the same ones. */
const memberRefsOf = async (
  store: MessageStore,
  project: string | null,
  includeProposed: boolean,
): Promise<{ ref: string; proposed?: string; score?: number }[]> => {
  if (!project) return []
  const confirmed = new Set<string>()
  for (const relation of await store.knowledge.relations(null, project))
    if (
      isUsable(relation.standing) &&
      relation.kind === "member-of" &&
      relation.to === project &&
      /^person:.+/.test(relation.from)
    )
      confirmed.add(relation.from)
  const members: { ref: string; proposed?: string; score?: number }[] = [...confirmed].sort().map((ref) => ({ ref }))
  if (!includeProposed) return members
  for (const one of await proposedLinksOf(store, project))
    if (/^person:.+/.test(one.from) && !members.some((member) => member.ref === one.from))
      members.push({ ref: one.from, proposed: one.id, ...(one.score === undefined ? {} : { score: one.score }) })
  return members
}

/**
 * Members are read by what their identities wrote, like `--contact person:<id>` but without the owner's aliases:
 * a short alias would add a text lane that matches mentions, and membership is about who wrote, not who was named.
 */
const memberLanesOf = async (
  store: MessageStore,
  project: string | null,
  given: Set<string>,
  room: number,
  includeProposed: boolean,
) => {
  const lanes: Contact[] = []
  const left: { source: string; kind: string; reason: "member-limit" | "no-identity" }[] = []
  const rows: ProjectMember[] = []
  for (const member of (await memberRefsOf(store, project, includeProposed)).filter((one) => !given.has(one.ref))) {
    const { ref: reference, ...marks } = member
    const person = await store.people.personByUid(reference.slice("person:".length))
    const senders = person ? sendersOf(person) : []
    const state = !senders.length ? "no-identity" : lanes.length >= room ? "member-limit" : "read"
    if (state === "read") lanes.push({ reference, senders })
    else left.push({ source: reference, kind: "member", reason: state })
    rows.push({ person: reference, state, ...marks })
  }
  return { lanes, left, rows }
}

export interface LinkedChat {
  provider: string
  account: string
  chat: string
  /** The link's free role (`source report`, `what worked`), if the owner set one. */
  role: string | null
  /** What the chat is for in the project; `null` means `work`. */
  purpose: string | null
  /** The confirmed link's id; null for a proposed one. */
  relationship: string | null
  /** The proposal that links the chat; only with `includeProposed`. */
  proposed?: string
  score?: number
}

const chatOf = (from: string) => {
  if (!from.startsWith("chat:")) return undefined
  const reference = parseReference(from)
  return reference.type === "chat" ? reference : undefined
}

/**
 * Links the owner confirmed, then, when asked, the proposed ones: a suggestion would put a whole chat into the
 * evidence on a guess, so it is read only on request and marked.
 */
export const linkedChatsOf = async (
  store: MessageStore,
  project: string | null,
  options: { includeProposed?: boolean } = {},
): Promise<LinkedChat[]> => {
  if (!project) return []
  const chats: LinkedChat[] = []
  for (const relation of await store.knowledge.relations(null, project)) {
    if (!relation.confirmed || relation.kind !== "member-of" || relation.to !== project) continue
    const reference = chatOf(relation.from)
    if (reference)
      chats.push({
        provider: reference.provider,
        account: reference.account,
        chat: reference.chat,
        role: relation.role,
        purpose: relation.purpose,
        relationship: relation.id,
      })
  }
  if (!options.includeProposed) return chats
  for (const one of await proposedLinksOf(store, project)) {
    const reference = chatOf(one.from)
    if (!reference) continue
    if (
      chats.some(
        (chat) =>
          chat.provider === reference.provider && chat.account === reference.account && chat.chat === reference.chat,
      )
    )
      continue
    chats.push({
      provider: reference.provider,
      account: reference.account,
      chat: reference.chat,
      role: one.role,
      purpose: one.purpose,
      relationship: null,
      proposed: one.id,
      ...(one.score === undefined ? {} : { score: one.score }),
    })
  }
  return chats
}

/** A linked chat whose purpose this run did not read: counted, never listed. */
export interface LeftOutChat {
  ref: string
  provider: string
  account: string
  chat: string
  title: string | null
  purpose: string
  relationship: string | null
  proposed?: string
  messages: number
  firstAt: string | null
  lastAt: string | null
}

/** Over half the items and at least this many, from one chat's membership alone: worth asking what the chat is for. */
const HINT_ITEMS = 20

type Gathered = Awaited<ReturnType<typeof gatherProjectEvidence>>

export type StoredProjectGathering = Omit<Gathered, "items" | "linkedChats"> & {
  /** `proposed`: the proposal whose link alone brought the item in; only with `includeProposed`. */
  items: (Gathered["items"][number] & { proposed?: string })[]
  linkedChats: (Gathered["linkedChats"][number] & { purpose: string; proposed?: string; score?: number })[]
  projectRef: string | null
  unreadSources: {
    source: string
    kind: string
    reason?: "out-of-scope" | "linked-chat-limit" | "member-limit" | "no-identity" | "unknown-provider"
  }[]
  mentions: EvidenceMentions
  /** The purposes read: `all`, or the list. */
  purposes: "all" | string[]
  leftOut: LeftOutChat[]
  members: ProjectMember[]
  /** One linked chat with no purpose set gave most of this run's items; a first run only, so it is said once. */
  purposeHint: { chat: string; relationship: string; items: number; of: number } | null
}

/**
 * `projects evidence` over a whole store: the project's names, key and aliases, the given words and contacts, its
 * confirmed person members and its confirmed linked chats, in the sources the host resolved.
 */
export const gatherStoredProject = async (
  store: MessageStore,
  input: StoredProjectInput,
): Promise<StoredProjectGathering> => {
  if (input.asOf !== undefined && input.after !== undefined && input.asOf <= input.after)
    throw new CliError("validation_error", "--before-time must be later than --since-time", { param: "before_time" })
  if (!store.contextEvidence)
    throw new CliError("configuration_error", "Stored context reads are unavailable in this store")
  const project = await projectOf(store, input.project)
  const { sources, unread, scope } = input.sources
  if (sources.length === 0)
    throw new CliError("not_found", "no selected source holds anything to read", { param: "source" })
  const contacts = (
    await Promise.all([...new Set(input.people ?? [])].map((contact) => contactOf(store, contact)))
  ).flat()
  const aliases = [...new Set([...project.aliases, ...(input.aliases ?? [])])].filter((alias) => alias !== project.name)
  // Counted without merging look-alikes, so the room left for members is never more than Core will take.
  const searchLanes =
    1 +
    (project.key ? 1 : 0) +
    aliases.length +
    (input.keywords?.length ?? 0) +
    contacts.filter((one) => one.name).length
  const room = Math.min(
    CORE_LIMIT - contacts.length,
    CORE_LIMIT - searchLanes - contacts.filter((one) => one.senders).length,
  )
  const includeProposed = input.includeProposed === true
  const purposes = purposesOf(input.purposes, input.purposeConfig, project)
  const members = await memberLanesOf(
    store,
    project.ref,
    new Set(contacts.flatMap((one) => one.reference ?? [])),
    room,
    includeProposed,
  )
  const people = [...contacts, ...members.lanes]
  const all = await linkedChatsOf(store, project.ref, { includeProposed })
  const linked = all.filter((one) => purposeRead(purposes, one.purpose))
  const linkedChats = linked.slice(0, LINKED_CHATS).map(({ provider, account, chat }) => ({ provider, account, chat }))
  const budgets = {
    ...(input.maxReads === undefined ? {} : { maxReads: input.maxReads }),
    ...(input.limit === undefined ? {} : { maxItems: input.limit }),
    ...(input.maxFetchMs === undefined ? {} : { maxFetchMs: input.maxFetchMs }),
  }
  const gathered = await gatherProjectEvidence(
    {
      evidence: store.contextEvidence,
      neighbours: storedNeighbours(store),
      coverage: (account, chatIds) => chatCoverage(store, account, chatIds),
      ...(store.contextIndex ? { index: store.contextIndex } : {}),
      ...(input.fetcher ? { fetcher: input.fetcher } : {}),
      ...(input.onFetchProgress ? { onFetchProgress: input.onFetchProgress } : {}),
    },
    {
      project: {
        name: project.name,
        ...(project.key ? { key: project.key } : {}),
        ...(aliases.length ? { aliases } : {}),
      },
      index: input.catchUp === false ? "as-is" : "update",
      around: { before: input.beforeN ?? 2, after: input.afterN ?? 2 },
      ...(input.keywords?.length ? { keywords: input.keywords } : {}),
      ...(people.length ? { people } : {}),
      ...(linkedChats.length ? { linkedChats } : {}),
      ...(input.fetcher ? { fetch: "before-read" as const } : {}),
      sources,
      scope,
      ...(input.days === undefined ? {} : { lookbackDays: input.days }),
      ...(input.after === undefined ? {} : { after: input.after }),
      ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
      ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
      ...(Object.keys(budgets).length ? { budgets } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  )
  const mentions = await findEvidenceMentions(store.knowledge, gathered, { exclude: project.ref })
  const unreadChats = [
    ...gathered.linkedChats
      .filter((one) => one.state === "out-of-scope")
      .map((one) => ({ source: one.ref, kind: "linked-chat", reason: "out-of-scope" as const })),
    ...linked.slice(LINKED_CHATS).map((one) => ({
      source: formatReference({ type: "chat", ...one }),
      kind: "linked-chat",
      reason: "linked-chat-limit" as const,
    })),
  ]
  const refOf = (one: LinkedChat) => formatReference({ type: "chat", ...one })
  const byRef = new Map(linked.map((one) => [refOf(one), one]))
  const proposedLanes = new Map<string, string>()
  for (const row of gathered.linkedChats) {
    const proposed = byRef.get(row.ref)?.proposed
    if (proposed && row.lane !== null) proposedLanes.set(row.lane, proposed)
  }
  for (const lane of gathered.lanes) {
    const proposed = members.rows.find((one) => one.proposed && lane.people.includes(one.person))?.proposed
    if (proposed && lane.kinds.includes("sender")) proposedLanes.set(lane.id, proposed)
  }
  // Marked only when nothing but proposed links found it: an item a word or a confirmed link found is evidence anyway.
  const items = gathered.items.map((item) => {
    const proposed = item.lanes.every((lane) => proposedLanes.has(lane))
      ? proposedLanes.get(item.lanes[0] ?? "")
      : undefined
    return proposed ? { ...item, proposed } : item
  })
  const linkedRows = gathered.linkedChats.map((row) => {
    const link = byRef.get(row.ref)
    return {
      ...row,
      purpose: link?.purpose ?? LINK_PURPOSE,
      ...(link?.proposed ? { proposed: link.proposed } : {}),
      ...(link?.score === undefined ? {} : { score: link.score }),
    }
  })
  const count = input.count ?? storedChatCount(store)
  const leftOut: LeftOutChat[] = []
  for (const one of all.filter((chat) => !purposeRead(purposes, chat.purpose))) {
    const account = { provider: one.provider, account: one.account }
    const [counted, [held]] = await Promise.all([
      count(account, one.chat, { since: gathered.window.after, until: gathered.window.before }),
      chatCoverage(store, account, [one.chat]),
    ])
    leftOut.push({
      ref: refOf(one),
      provider: one.provider,
      account: one.account,
      chat: one.chat,
      title: held?.title ?? null,
      purpose: one.purpose ?? LINK_PURPOSE,
      relationship: one.relationship,
      ...(one.proposed ? { proposed: one.proposed } : {}),
      ...counted,
    })
  }
  return {
    projectRef: project.ref,
    unreadSources: [...unread, ...unreadChats, ...members.left],
    ...gathered,
    items,
    linkedChats: linkedRows,
    mentions,
    purposes: purposes === "all" ? "all" : [...purposes],
    leftOut,
    members: members.rows,
    purposeHint: gathered.resumed ? null : purposeHintOf(linked, linkedRows, items.length),
  }
}

const purposeHintOf = (
  linked: LinkedChat[],
  rows: { ref: string; items?: number }[],
  of: number,
): StoredProjectGathering["purposeHint"] => {
  const [top] = [...rows].sort((a, b) => (b.items ?? 0) - (a.items ?? 0))
  const items = top?.items ?? 0
  const link = linked.find((one) => formatReference({ type: "chat", ...one }) === top?.ref)
  if (!top || !link?.relationship || link.purpose !== null || items < HINT_ITEMS || items * 2 <= of) return null
  return { chat: top.ref, relationship: link.relationship, items, of }
}
