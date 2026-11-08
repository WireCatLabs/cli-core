import type { MessageStore } from "../../store/store.js"
import type { AccountKey } from "../../store/types.js"
import type { ProposalRow } from "../proposals/types.js"

/** One scorer's reason to link a chat, a mail thread or a person to a project, or a person to a person. */
export interface LinkCandidate {
  /** `chat:…` (a mail thread is `chat:email/…`) or `person:…`. */
  from: string
  /** `project:…`, or `person:…` for a person ↔ person rule. */
  to: string
  kind: "member-of" | "related-to"
  /** 0..1. */
  weight: number
  /** Ids, counts and at most a chat's title, never message text. */
  why: string
  evidence: string[]
  /**
   * The `contact:<provider>/<id>` a person candidate was found by. A person candidate without one, or with one that
   * is not that person's, is refused: people are matched by identity, never by name.
   */
  identity?: string
  /** What the chat is for in the project, one of the configured purposes; absent means the default, `work`. */
  purpose?: string
}

export interface ScannedProject {
  ref: string
  name: string
  key: string | null
  aliases: string[]
}

export interface ScorerInput {
  store: MessageStore
  /** `null` for a scan with no project, which only person ↔ person rules answer. */
  project: ScannedProject | null
  /** The project's confirmed chats and people, and, within one scan, what the scan already found above threshold. */
  confirmed: { chats: string[]; people: string[] }
  /** Explicit; never a default account. */
  sources: AccountKey[]
  /** ISO 8601: the start of the window message signals count in. */
  since: string
  /** The purposes the host's config lists; a candidate's purpose outside them is dropped. */
  purposes: readonly string[]
  /** The owner's `person:` reference, never a candidate. */
  owner: string | null
  signal?: AbortSignal
}

export interface LinkScorer {
  readonly id: string
  readonly version: number
  /** Reads `confirmed`, so a scan runs it again each time the links it spreads from grow. */
  readonly spreads?: boolean
  candidates(input: ScorerInput): Promise<LinkCandidate[]>
}

export type Signal = NonNullable<ProposalRow["signals"]>[number]

export interface ScannedProposal extends LinkCandidate {
  score: number
  signals: Signal[]
  /** The stored proposal; `null` in a dry run for a pair nothing holds yet. */
  id: string | null
  state: "new" | "updated" | "unchanged" | "dry-run"
}

export interface ScanResult {
  project: string | null
  proposals: ScannedProposal[]
  skipped: {
    /** A link already joins the pair. */
    confirmed: number
    /** The owner (or an agent for the owner) rejected the pair once; it is never proposed again. */
    rejected: number
    belowThreshold: number
    /** Over the limit of new proposals for one run, lowest scores first. */
    overLimit: number
    /** A person candidate with no identity behind it. */
    nameOnly: number
    /** An end the store does not hold, or a chat outside the sources. */
    unresolved: number
  }
}
