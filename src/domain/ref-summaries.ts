import { singleLine } from "@wirecat/cli-base"
import { providerNamed } from "./providers.js"
import type { RefKindName } from "./references.js"

export type RefState = "available" | "deleted" | "unavailable"
/** A message or chat of the `email` provider is mail, so it reads as `email` and `email_thread`. */
export type RefSummaryKind = RefKindName | "email" | "email_thread" | "unknown"

/** What a reference names, read from the store in one batch so a page of refs costs one query per kind. */
export interface RefSummary {
  /** Canonical spelling; the map key is the text the caller passed. */
  ref: string
  kind: RefSummaryKind
  /** One line, at most 120 characters, never a message body. `null` when the store has no title. */
  title: string | null
  /** What holds it, one line: a message's chat title, a task's project, a document's provider label. */
  in: string | null
  /** ISO 8601 UTC. */
  at: string | null
  provider: string | null
  /** The external id of the account that holds it, for `ProfilesFor`; `null` when it belongs to no account. */
  account: string | null
  /** The CLI that opens it (`max`, `tg`, `drive`); `null` when no CLI has registered the provider. */
  tool: string | null
  state: RefState
  /** Only with `{ excerpt: true }`: at most 280 characters of the body. */
  excerpt?: string | null
}

export interface RefsStore {
  /** One query per kind present. Never throws for a bad ref: it comes back `unknown`, `unavailable`. */
  summaries(refs: readonly string[], options?: { excerpt?: boolean }): Promise<Map<string, RefSummary>>
}

/** The caller's answer to "which profile opens this": one signed in, or the choices and why there is not one. */
export type ProfilesFor = (
  provider: string,
  account: string | null,
) => { profile: string } | { why: string; profiles: string[] }

export interface RefOpen {
  /** Ready to run; contains `<profile>` when `profiles` is not exactly one. `null` when no CLI opens it. */
  argv: string[] | null
  profiles: string[]
  why: string | null
}

export const PROFILE_PLACEHOLDER = "<profile>"

/** A title from someone else's text, as one line: a newline in it would break every row it is printed in. */
export const oneLine = (text: string): string => singleLine(text.replace(/\s+/g, " ").trim())

/** Mail is a message and a chat to the provider registry: `opens` is keyed by the reference kind. */
const openKind = (kind: RefSummaryKind): RefKindName | undefined =>
  kind === "email" ? "message" : kind === "email_thread" ? "chat" : kind === "unknown" ? undefined : kind

/**
 * The command that opens a ref. A registered provider opens its own kinds; anything else opens with the caller's
 * `local` words (memo's `notes show`). The profile is never picked: with none or several, `argv` keeps `<profile>`.
 */
export const openOf = (
  summary: RefSummary,
  ports: { profilesFor: ProfilesFor; local?: Partial<Record<RefKindName, string[]>> },
): RefOpen => {
  const kind = openKind(summary.kind)
  if (kind === undefined) return { argv: null, profiles: [], why: `${summary.ref} is not a reference` }
  const entry = summary.provider === null ? undefined : providerNamed(summary.provider)
  const words = entry?.command === undefined ? undefined : entry.opens?.[kind]
  if (entry?.command !== undefined && words !== undefined && summary.provider !== null) {
    const command = [...words.split(" "), summary.ref]
    const asked = ports.profilesFor(summary.provider, summary.account)
    return "profile" in asked
      ? { argv: [entry.command, asked.profile, ...command], profiles: [asked.profile], why: null }
      : { argv: [entry.command, PROFILE_PLACEHOLDER, ...command], profiles: asked.profiles, why: asked.why }
  }
  const local = ports.local?.[kind]
  if (local !== undefined) return { argv: [...local, summary.ref], profiles: [], why: null }
  return {
    argv: null,
    profiles: [],
    why:
      summary.provider === null
        ? `nothing here opens a ${kind}`
        : `no CLI has registered ${summary.provider} in this store yet; run its CLI once`,
  }
}

const WORDS: Record<RefSummaryKind, string> = {
  message: "Message",
  chat: "Chat",
  contact: "Contact",
  folder: "Folder",
  meeting: "Meeting",
  event: "Event",
  note: "Note",
  document: "Document",
  person: "Person",
  organization: "Organization",
  project: "Project",
  task: "Task",
  memory: "Memory",
  fact: "Fact",
  bot: "Bot",
  invoice: "Invoice",
  payment: "Payment",
  order: "Order",
  deal: "Deal",
  lead: "Lead",
  pipeline: "Pipeline",
  product: "Product",
  contract: "Contract",
  subscription: "Subscription",
  wallet: "Wallet",
  transaction: "Transaction",
  email: "Email",
  email_thread: "Email thread",
  unknown: "Unknown",
}

/** `Chat «Сайт + автоматизация» (MAX)`: the one label every review row, status line and `show` prints. */
export const refLabel = (summary: RefSummary): string => {
  const named = summary.title === null ? summary.ref : `«${oneLine(summary.title)}»`
  const notes = [summary.in === null ? null : oneLine(summary.in), summary.state === "available" ? null : summary.state]
    .filter((one) => one !== null)
    .join(", ")
  return `${WORDS[summary.kind]} ${named}${notes === "" ? "" : ` (${notes})`}`
}
