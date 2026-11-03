import type { BudgetStop, RunBudget } from "../background/budget.js"
import type { LoadEngine } from "../readers/types.js"
import type { AccountKey, MessageStore } from "../store/index.js"
import type { MailAttachmentPolicy } from "./attachments.js"
import type { PartialOutcome } from "./partial.js"
import type { TagOutcome } from "./rule-tags.js"
import type { MailRule } from "./rules.js"
import type { DomainAge } from "./score.js"

export interface MailAccount {
  /** The mailbox address: the store's account id. */
  address: string
  mode?: "gmail" | "imap" | "mbox"
  folders?: string[]
  rules?: MailRule[]
}

/** What an index step reports, as memo's embedding does; the sync only passes it on. */
export interface MailIndexed {
  chats: number
  chunks: number
  left: boolean
  notEmbedded?: unknown
}

export interface MailSyncResult {
  account: string
  since: string
  listed: number
  saved: number
  alreadyStored: number
  /** New emails a skip rule kept out: never read, never stored. */
  skipped: number
  /** New emails an envelope rule recorded: sender, date, size and labels, never their text. */
  envelopes: number
  deleted: number
  /** False when `max` stopped the run before every new message was read; the next run continues. */
  complete: boolean
  /** `partial`: a budgeted run stopped before the whole window was read; the next run goes on. */
  state?: "partial" | "complete"
  /** Why a budgeted run stopped early: its request budget, its deadline, or a cancel. */
  stopped?: BudgetStop
  /** Messages of the window this run did not get to read: left by a budget, or by `max`. */
  remaining?: number
  /** Requests a budgeted run spent. */
  requests?: number
  /** Emails that could not be read or parsed; they are tried again next run. */
  unreadable?: { message: string; reason: string }[]
  /** Why stored messages missing at the source were left alone, when they were. */
  deletionsSkipped?: string
  /** Folders whose server refused SEARCH: left unread, so the run is partial and proves no deletion. */
  refusedFolders?: string[]
  /** "resumed": only mail not done before was listed; "full": every message in the window was. */
  pass?: "full" | "resumed"
  indexed?: MailIndexed
  coverage?: { folders: string[]; since: string; until: string; state: "window" | "partial"; identity: string }
  attachments?: { message: string; part: number; status: string }[]
  /** Rule tags put on mail as an existing label the store pointed to. */
  tagsReused?: TagOutcome["reused"]
  /** Rule tags the store refused with nothing to reuse; that mail is stored untagged. */
  tagsSkipped?: TagOutcome["skipped"]
  /** Emails a server search stored from their first bytes, read whole this run, and those still partial. */
  partial?: PartialOutcome
  /** `--retry-attachments`: emails read again for attachments a missing reader left unread. */
  retried?: { emails: number; extracted: number; stillFailed: number; missing: number }
}

export interface MailSyncOptions {
  account: MailAccount
  since: Date
  max?: number
  maxBodyChars?: number
  maxAttachmentChars?: number
  /** Whether attachments are read into the index, and up to what size; `DEFAULT_ATTACHMENT_POLICY` when left out. */
  attachments?: MailAttachmentPolicy
  now?: () => number
  /** Domain registration dates already known, for the sender score a rule asks for. */
  ages?: ReadonlyMap<string, DomainAge>
  loadEngine?: LoadEngine
  retryAttachments?: boolean
  /** List every message in the window, not only those an earlier run left: proves deletions, refreshes labels. */
  rescan?: boolean
  /** `false` for a spot read, like the copy of a sent message: the run leaves the saved coverage as the last full run set it. */
  saveCoverage?: boolean
  /** A window smaller than this is listed whole every run: it costs seconds and keeps flags and deletions current. */
  resumeFrom?: number
  /** Runs after the mail is saved, so chats and mail still waiting for vectors are indexed; its answer is `indexed`. */
  index?: (store: MessageStore, key: AccountKey) => Promise<MailIndexed>
  /** Stops between batches of emails, after saving the resume point. */
  signal?: AbortSignal
  /**
   * Makes the run budgeted: it reads the window in rounds, one request of the budget per call to the source, saves
   * after each, stops when the budget says so and answers `state: "partial"`. A message the source could not give
   * is tried once more at the end of the run and, if it still fails, left for the next one. `max` defaults to no limit.
   */
  budget?: RunBudget
  /** Pauses before a round is read again after the store was locked; tests pass one that does not wait. */
  wait?: (ms: number) => Promise<void>
  /** `false` for a spot read: emails a server search stored from their first bytes are not read whole this run. */
  completePartial?: boolean
}
