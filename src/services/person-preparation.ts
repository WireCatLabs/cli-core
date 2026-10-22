import { CliError } from "@wirecat/cli-base"
import type { Id, Provider } from "../domain/models.js"
import { parseMeetingReference } from "../meetings/index.js"
import type { AccountKey, MessageStore, PreparationFact, PreparationNote, PreparationTask } from "../store/store.js"
import {
  CONTEXT_BYTES,
  CONTEXT_MESSAGES,
  type ContextMessage,
  type ContextOptions,
  type PersonContext,
  personContext,
  readsOf,
  toContext,
} from "./person-context.js"
import { type PersonMeetingContextItem, personMeetingContext } from "./person-meeting-context.js"

export const PREPARE_BYTES = 96 * 1024
const MEETINGS = 5
const CUES = 3

export interface WaitingDialog {
  provider: Provider
  account: Id
  chatId: Id
  title: string | null
  /** Their message, the newest the store holds in this one-to-one chat. */
  message: ContextMessage
  /** The store does not hold the whole chat, so a later answer may be missing from it. */
  partial: boolean
}

type Cut = "limit" | "bytes" | null
interface SectionCoverage {
  included: number
  hasMore: boolean
  cutBy: Cut
}

export interface PersonPreparation extends PersonContext {
  prepare: {
    waiting: WaitingDialog[]
    tasks: PreparationTask[]
    facts: PreparationFact[]
    notes: PreparationNote[]
    meetings: PersonMeetingContextItem[]
    limits: { items: number; bytes: number }
    coverage: {
      waiting: SectionCoverage & { rule: "their message is the newest the store holds in a one-to-one chat" }
      tasks: SectionCoverage & { selection: "open, assigned to them in any role"; accounts: string[] }
      facts: SectionCoverage & { selection: "accepted, about them or a project they are a member of" }
      /** `withheld` when the profile denies `contacts.notes.list`. */
      notes: SectionCoverage & { selection: "written by you, about them"; withheld?: "contacts.notes.list" }
      /** `accounts`: the ones their meetings came from. */
      meetings: SectionCoverage & {
        read: "every account of the store that saw them"
        accounts: string[]
        pending: number
      }
    }
  }
}

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")
const accountName = ({ provider, account }: AccountKey) => `${provider}:${account}`

/**
 * `contacts context` and what to know before talking to them: the one-to-one chats where they wrote last, open tasks,
 * accepted facts, your notes and their recent meetings, each item with its reference. The messages keep their own
 * budget; the sections share what is left of `PREPARE_BYTES`, in that order, so evidence comes first.
 */
export const personPreparation = async (
  store: MessageStore,
  asked: AccountKey,
  reference: string,
  options: ContextOptions & { notes?: boolean } = {},
): Promise<PersonPreparation> => {
  const context = await personContext(store, asked, reference, { ...options, bytes: CONTEXT_BYTES })
  const limit = options.messages ?? CONTEXT_MESSAGES
  let left = PREPARE_BYTES - size({ recent: context.recent, mentions: context.mentions })
  const budgeted = <T>(page: { items: T[]; hasMore: boolean }): { items: T[]; coverage: SectionCoverage } => {
    const items: T[] = []
    let cut = false
    for (const item of page.items.slice(0, limit)) {
      const bytes = size(item)
      if (cut || bytes > left) {
        cut = true
        continue
      }
      left -= bytes
      items.push(item)
    }
    const over = page.hasMore || page.items.length > limit
    return {
      items,
      coverage: { included: items.length, hasMore: over || cut, cutBy: cut ? "bytes" : over ? "limit" : null },
    }
  }

  const reads = readsOf(context.person, asked)
  const partial = new Set(context.notRead.map((chat) => `${chat.provider}/${chat.account}/${chat.chatId}`))
  const waiting: WaitingDialog[] = []
  for (const chat of context.shared.filter((one) => one.kind === "dialog")) {
    const key = { provider: chat.provider, account: chat.account }
    const [newest] = (await store.messages.messages(key, chat.chatId, { limit: 1 })).items
    if (newest?.outgoing !== false) continue
    waiting.push({
      ...key,
      chatId: chat.chatId,
      title: chat.title,
      message: toContext(key, newest, chat.title),
      partial: partial.has(`${chat.provider}/${chat.account}/${chat.chatId}`),
    })
  }
  waiting.sort((a, b) => Date.parse(b.message.timestamp) - Date.parse(a.message.timestamp))

  const accounts = [...new Map(reads.map(({ key }) => [accountName(key), key])).values()]
  const held = await store.people.preparation(context.person.uid, { accounts, limit })

  const stored = await store.accounts.storedAccounts()
  const meetings = await meetingsOf(store, context.person.uid, stored, options.since, () => left)

  const sections = {
    waiting: budgeted({ items: waiting, hasMore: false }),
    tasks: budgeted(held.tasks),
    facts: budgeted(held.facts),
    notes: budgeted(options.notes === false ? { items: [], hasMore: false } : held.notes),
    meetings: budgeted({ items: meetings.items, hasMore: meetings.hasMore }),
  }
  return {
    ...context,
    prepare: {
      waiting: sections.waiting.items,
      tasks: sections.tasks.items,
      facts: sections.facts.items,
      notes: sections.notes.items,
      meetings: sections.meetings.items,
      limits: { items: limit, bytes: PREPARE_BYTES },
      coverage: {
        waiting: {
          ...sections.waiting.coverage,
          rule: "their message is the newest the store holds in a one-to-one chat",
        },
        tasks: {
          ...sections.tasks.coverage,
          selection: "open, assigned to them in any role",
          accounts: accounts.map(accountName),
        },
        facts: { ...sections.facts.coverage, selection: "accepted, about them or a project they are a member of" },
        notes: {
          ...sections.notes.coverage,
          selection: "written by you, about them",
          ...(options.notes === false ? { withheld: "contacts.notes.list" as const } : {}),
        },
        meetings: {
          ...sections.meetings.coverage,
          read: "every account of the store that saw them",
          accounts: meetings.accounts,
          pending: meetings.pending,
        },
      },
    },
  }
}

/** Their recent meetings in every account of the store that saw them; none is not an error. */
const meetingsOf = async (
  store: MessageStore,
  uid: string,
  stored: { id: number; provider: Provider; account: Id }[],
  since: number | undefined,
  left: () => number,
): Promise<{ items: PersonMeetingContextItem[]; hasMore: boolean; accounts: string[]; pending: number }> => {
  const none = { items: [], hasMore: false, accounts: [], pending: 0 }
  if (!stored.length || left() < 2) return none
  try {
    const found = await personMeetingContext(store, `person:${uid}`, {
      accountIds: stored.slice(0, 1000).map(({ id }) => id),
      meetings: MEETINGS,
      cues: CUES,
      bytes: Math.min(left(), 4 * 1024 * 1024),
      ...(since === undefined ? {} : { since }),
    })
    const read = new Set(found.items.map((item) => parseMeetingReference(item.reference).accountId))
    return {
      items: found.items,
      hasMore: found.coverage.truncatedBy !== null || found.coverage.scanLimitReached,
      accounts: stored.filter(({ id }) => read.has(id)).map(accountName),
      pending: found.coverage.pending,
    }
  } catch (error) {
    if (error instanceof CliError && error.code === "not_found") return none
    throw error
  }
}
