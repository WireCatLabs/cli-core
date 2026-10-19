import { CliError } from "@wirecat/cli-base"
import { formatLocator, parseLocator } from "../domain/locator.js"
import type { MessageStore } from "../store/index.js"
import type { MessagesStore } from "../store/messages.js"
import { excerpt } from "./excerpt.js"

export interface ProjectNeighbour {
  ref: string
  at: number
  sender: string | null
  text: string
  found: boolean
}
/** The stored messages or emails next to a hit, oldest first, without the hit itself. */
export interface ProjectNeighbourReader {
  around(
    ref: string,
    window: { before: number; after: number },
  ): Promise<{ ref: string; at: number; sender: string | null; text: string }[]>
}

export const storedMessageNeighbours = (messages: Pick<MessagesStore, "around">): ProjectNeighbourReader => ({
  async around(ref, window) {
    const at = parseLocator(ref)
    if (at.provider === "email") return []
    const rows = await messages.around({ provider: at.provider, account: at.account }, at.chat, at.message, window)
    return rows
      .filter((row) => !row.anchor)
      .map((row) => ({
        ref: formatLocator({ ...at, message: row.id }),
        at: Date.parse(row.timestamp),
        sender: row.senderName,
        text: row.text ?? "",
      }))
  },
})

/**
 * Neighbours are context for reading a hit, not matches: they never join `items`, and their text counts against
 * the run's read bytes.
 */
export const attachNeighbours = async (
  items: { ref: string; kind: string; around?: ProjectNeighbour[] | null; aroundIssue?: string | null }[],
  reader: ProjectNeighbourReader | undefined,
  window: { before: number; after: number },
  budget: { remaining: () => number; charge: (bytes: number) => void },
  known: (ref: string) => boolean,
  signal?: AbortSignal,
) => {
  if (!reader || window.before + window.after === 0) return
  for (const item of items) {
    if (item.kind !== "message" && item.kind !== "mail") continue
    if (budget.remaining() <= 0) {
      item.around = null
      item.aroundIssue = "read-bytes"
      continue
    }
    signal?.throwIfAborted()
    try {
      const rows = await reader.around(item.ref, window)
      const around: ProjectNeighbour[] = []
      for (const row of rows.slice(0, window.before + window.after)) {
        const text = excerpt(row.text, "", 200)
        const bytes = Buffer.byteLength(text)
        if (bytes > budget.remaining()) {
          item.aroundIssue = "read-bytes"
          break
        }
        budget.charge(bytes)
        around.push({ ...row, text, found: known(row.ref) })
      }
      item.around = around
    } catch (error) {
      signal?.throwIfAborted()
      if (!(error instanceof CliError)) throw error
      item.around = null
      item.aroundIssue = error.code
    }
  }
}

/** Chat messages next to a hit in its chat, and the emails before and after a mail hit in its thread. */
export const storedNeighbours = (
  store: Pick<MessageStore, "messages" | "mail" | "accounts">,
): ProjectNeighbourReader => {
  const messages = storedMessageNeighbours(store.messages)
  return {
    async around(ref, window) {
      const at = parseLocator(ref)
      if (at.provider !== "email") return messages.around(ref, window)
      const account = await store.accounts.storedAccount({ provider: at.provider, account: at.account })
      const email = await store.mail.email(account.id, at.message)
      if (!email) throw new CliError("not_found", "the hit's email is no longer stored")
      const thread = await store.mail.thread(email.emailThreadId)
      const emails = thread?.emails ?? []
      const index = emails.findIndex((one) => one.id === email.id)
      if (index < 0) return []
      return [
        ...emails.slice(Math.max(0, index - window.before), index),
        ...emails.slice(index + 1, index + 1 + window.after),
      ].map((one) => ({
        ref: formatLocator({ ...at, message: one.externalId }),
        at: one.sentAt ?? one.receivedAt ?? 0,
        sender: one.fromName ?? one.fromAddress,
        text: [one.subject, one.bodyText ?? one.snippet].filter(Boolean).join(" — "),
      }))
    },
  }
}
