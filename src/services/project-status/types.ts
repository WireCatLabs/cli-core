import type { ChatKind, Id, Message } from "../../domain/models.js"
import type { AccountKey, MessageStore } from "../../store/store.js"
import type { ChatCoverage } from "../chat-coverage.js"

/** What every chat signal reads; loaded once per chat by the pipeline. Never printed. */
export interface StatusChat {
  /** `chat:<provider>/<account>/<chat>` */
  ref: string
  account: AccountKey
  chatId: Id
  title: string | null
  kind: ChatKind
  /** The link's role: "client", "contractor", or null. */
  role: string | null
  /** The chat's purpose in the project; `work` until links carry one. */
  purpose: string
  /** `project:<id>`; a child's id when rolled up. */
  project: string
  coverage: ChatCoverage
  /** Oldest first, the window, at most `STATUS_WINDOW`. */
  messages: Message[]
}

export interface StatusProject {
  ref: string
  key: string | null
  name: string
}

export interface StatusChild extends StatusProject {
  parent: string
  depth: number
}

export interface StatusContext {
  now: number
  /** Window start, ms. */
  since: number
  chats: StatusChat[]
  project: StatusProject & {
    children: StatusChild[]
    /** Children not read: too deep, seen twice, or past the limit. */
    cut: { ref: string; reason: "depth" | "cycle" | "limit" }[]
  }
  /** Read only: facts, tasks, chats. */
  store: MessageStore
  /** `--context-query` texts: every word of one must appear in one message. */
  contextQueries: string[]
}

export interface StatusWho {
  ref: string | null
  name: string | null
  owner: boolean
}

/** One finding of a signal. Stable keys; the signal adds its own under `data`. */
export interface StatusItem<D = Record<string, unknown>> {
  signal: string
  /** Null for a project level finding. */
  chat: string | null
  /** ISO, when it happened. */
  at: string | null
  who: StatusWho | null
  /** `msg:`, `fact:`, `task:` refs. */
  evidence: { ref: string; fingerprint: string | null }[]
  /** How sure: `pattern` is a word match, to check before it is trusted. */
  basis: "store" | "fact" | "task" | "pattern"
  data: D
}

export interface StatusAttention {
  chat: string
  weight: number
  why: string
}

export interface StatusSignal<D = Record<string, unknown>> {
  id: string
  /** Bumped when the logic changes, so a saved answer says which rules made it. */
  version: number
  scope: "chat" | "project"
  read(context: StatusContext, chat?: StatusChat): Promise<StatusItem<D>[]>
  /** Why a chat should be read next, weight 0 to 3; the pipeline sums them per chat. */
  attention?(items: StatusItem<D>[], context: StatusContext): StatusAttention[]
}
