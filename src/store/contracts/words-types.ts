import type { Id, Provider } from "../../domain/models.js"
import type { Term } from "../../search/query.js"
import type { AccountKey, StoredHit } from "./models.js"

export interface WordQuery {
  /** AND of groups, each an OR of terms. */
  required: Term[][]
  excluded: Term[]
}

export interface SearchScope {
  accounts: AccountKey[]
  chat?: { account: AccountKey; chatId: Id }
  sender?: { provider: Provider; id: Id }
  /** Any of these senders — always a join, whatever their size. */
  senders?: { provider: Provider; id: Id }[]
  /** `from:me`: what the account itself sent. */
  outgoing?: boolean
  /** Epoch ms, inclusive. */
  after?: number
  /** Epoch ms, exclusive. */
  before?: number
  /** Attachment kinds, `attachment` for any, `link` for a link in the text — all required. */
  has?: string[]
}

export interface WordOptions {
  /** Every group required, or any term enough. */
  mode: "every" | "any"
  /** Words of three letters or more match as the beginning of a word. */
  beginnings: boolean
  limit: number
  /** Newest first instead of by score. */
  newest?: boolean
}

/** A hit with its relevance — bm25 turned round so higher is better; `null` from steps that do not rank. */
/** `exact: false`: a stemmed search found it only through another form of the words. */
export type ScoredHit = StoredHit & {
  score: number | null
  exact?: boolean
  /** Where the words were: the message's text, a voice note's transcript, a file's name or a file's text. */
  matchedIn?: MatchPlace
  /** The text of that place, for the excerpt; never part of an answer. */
  matchedText?: string
}

export type MatchPlace = "text" | "transcript" | "filename" | "file"
