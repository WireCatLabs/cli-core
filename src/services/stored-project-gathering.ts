import { CliError } from "@wirecat/cli-base"
import type { ContextSource } from "../context/evidence.js"
import { formatReference, parseReference } from "../domain/references.js"
import type { MessageStore } from "../store/store.js"
import { chatCoverage } from "./chat-coverage.js"
import { gatherProjectEvidence, type ProjectChatFetcher, type ProjectGatheringPorts } from "./project-gathering.js"
import { storedNeighbours } from "./project-gathering-around.js"
import { type EvidenceMentions, findEvidenceMentions } from "./project-gathering-mentions.js"

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

/** Confirmed `person` members, in a stable order, so a cut at the lane limit always drops the same ones. */
const memberRefsOf = async (store: MessageStore, project: string | null) => {
  if (!project) return []
  const refs = []
  for (const relation of await store.knowledge.relations(null, project))
    if (
      relation.confirmed &&
      relation.kind === "member-of" &&
      relation.to === project &&
      /^person:.+/.test(relation.from)
    )
      refs.push(relation.from)
  return [...new Set(refs)].sort()
}

/**
 * Members are read by what their identities wrote, like `--contact person:<id>` but without the owner's aliases:
 * a short alias would add a text lane that matches mentions, and membership is about who wrote, not who was named.
 */
const memberLanesOf = async (store: MessageStore, project: string | null, given: Set<string>, room: number) => {
  const lanes: Contact[] = []
  const left: { source: string; kind: string; reason: "member-limit" | "no-identity" }[] = []
  for (const reference of (await memberRefsOf(store, project)).filter((one) => !given.has(one))) {
    const person = await store.people.personByUid(reference.slice("person:".length))
    const senders = person ? sendersOf(person) : []
    if (!senders.length) left.push({ source: reference, kind: "member", reason: "no-identity" })
    else if (lanes.length >= room) left.push({ source: reference, kind: "member", reason: "member-limit" })
    else lanes.push({ reference, senders })
  }
  return { lanes, left }
}

export interface LinkedChat {
  provider: string
  account: string
  chat: string
  /** The link's free role (`source report`, `what worked`), if the owner set one. */
  role: string | null
}

/** Only links the owner confirmed: a suggested one would put a whole chat into the evidence on a guess. */
export const linkedChatsOf = async (store: MessageStore, project: string | null): Promise<LinkedChat[]> => {
  if (!project) return []
  const chats: LinkedChat[] = []
  for (const relation of await store.knowledge.relations(null, project)) {
    if (!relation.confirmed || relation.kind !== "member-of" || relation.to !== project) continue
    if (!relation.from.startsWith("chat:")) continue
    const reference = parseReference(relation.from)
    if (reference.type === "chat")
      chats.push({
        provider: reference.provider,
        account: reference.account,
        chat: reference.chat,
        role: relation.role,
      })
  }
  return chats
}

export type StoredProjectGathering = Awaited<ReturnType<typeof gatherProjectEvidence>> & {
  projectRef: string | null
  unreadSources: {
    source: string
    kind: string
    reason?: "out-of-scope" | "linked-chat-limit" | "member-limit" | "no-identity" | "unknown-provider"
  }[]
  mentions: EvidenceMentions
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
  const members = await memberLanesOf(store, project.ref, new Set(contacts.flatMap((one) => one.reference ?? [])), room)
  const people = [...contacts, ...members.lanes]
  const linked = await linkedChatsOf(store, project.ref)
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
  return { projectRef: project.ref, unreadSources: [...unread, ...unreadChats, ...members.left], ...gathered, mentions }
}
