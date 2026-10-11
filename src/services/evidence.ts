import { createHash, randomUUID } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import { formatLocator, type MessageLocator } from "../domain/locator.js"
import type { Message, Page } from "../domain/models.js"

export type EvidenceKind = "chats" | "news" | "person"
export type EvidenceSource = Omit<MessageLocator, "message">

export interface EvidenceMessage {
  locator: string
  fingerprint: string
  timestamp: string
  editedAt: string | null
  senderId: string | null
  senderName: string | null
  senderIsChat: boolean
  outgoing: boolean | null
  text: string
  replyTo: string | null
  threadId: string | null
  attachmentKinds: string[]
}

export interface EvidencePacket {
  schemaVersion: 1
  id: string
  kind: EvidenceKind
  source: EvidenceSource
  fingerprint: string
  limits: { messages: number; bytes: number }
  /** UTF-8 bytes of the JSON items array, including brackets and separators. */
  contentBytes: number
  coverage: {
    provided: number
    included: number
    omitted: number
    hasMore: boolean
    /** A page alone cannot establish how complete the archive is. */
    history: "unknown"
    truncatedBy: "messages" | "bytes" | null
  }
  items: EvidenceMessage[]
}

export interface EvidencePacketInput {
  kind: EvidenceKind
  source: EvidenceSource
  page: Pick<Page<Message>, "items" | "hasMore">
  limits?: { messages?: number; bytes?: number }
}

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex")

const positive = (value: number, name: string, minimum = 1): number => {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new CliError("validation_error", `${name} must be a safe integer of at least ${minimum}`)
  return value
}

/** Builds from an already authorised page; preserves its order and never fetches or marks anything read. */
export const prepareEvidencePacket = ({
  kind,
  source,
  page,
  limits: requested,
}: EvidencePacketInput): EvidencePacket => {
  if (!["chats", "news", "person"].includes(kind))
    throw new CliError("validation_error", "evidence kind must be chats, news or person")
  if ([source.provider, source.account, source.chat].some((part) => !part.trim()))
    throw new CliError("validation_error", "evidence source must name a provider, account and chat")
  if (page.items.some((message) => message.chatId !== source.chat))
    throw new CliError("validation_error", "every evidence message must belong to the named chat")
  if (page.items.some((message) => !message.id.trim()))
    throw new CliError("validation_error", "every evidence message must have an id")
  if (new Set(page.items.map(({ id }) => id)).size !== page.items.length)
    throw new CliError("validation_error", "an evidence page must not repeat a message id")

  const limits = {
    messages: positive(requested?.messages ?? 100, "evidence message limit"),
    bytes: positive(requested?.bytes ?? 64 * 1024, "evidence byte limit", 2),
  }
  const scope = { provider: source.provider, account: source.account, chat: source.chat }
  const items: EvidenceMessage[] = []
  let contentBytes = 2
  let truncatedBy: EvidencePacket["coverage"]["truncatedBy"] = null
  for (const message of page.items) {
    if (items.length === limits.messages) {
      truncatedBy = "messages"
      break
    }
    const parent = message.replyToId ?? message.replyTo?.id
    const content = {
      locator: formatLocator({ ...scope, message: message.id }),
      timestamp: message.timestamp,
      editedAt: message.editedAt,
      senderId: message.senderId,
      senderName: message.senderName,
      senderIsChat: message.senderIsChat ?? false,
      outgoing: message.outgoing,
      text: message.text,
      replyTo: parent === undefined ? null : formatLocator({ ...scope, message: parent }),
      threadId: message.threadId ?? null,
      attachmentKinds: message.attachments.map(({ kind: attachmentKind }) => attachmentKind),
    }
    const item = { ...content, fingerprint: hash(content) }
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (items.length > 0 ? 1 : 0)
    if (bytes > limits.bytes - contentBytes) {
      truncatedBy = "bytes"
      break
    }
    items.push(item)
    contentBytes += bytes
  }

  const content = {
    schemaVersion: 1 as const,
    kind,
    source: scope,
    limits,
    contentBytes,
    coverage: {
      provided: page.items.length,
      included: items.length,
      omitted: page.items.length - items.length,
      hasMore: page.hasMore,
      history: "unknown" as const,
      truncatedBy,
    },
    items,
  }
  return { ...content, id: randomUUID(), fingerprint: hash(content) }
}
