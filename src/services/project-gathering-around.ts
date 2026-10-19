import { CliError } from "@wirecat/cli-base"
import { formatLocator, parseLocator } from "../domain/locator.js"
import type { MessagesStore } from "../store/messages.js"
import { excerpt } from "./excerpt.js"

export interface ProjectNeighbour {
  ref: string
  at: number
  sender: string | null
  text: string
  found: boolean
}
/** The stored messages next to a hit in its chat, oldest first, without the hit itself. */
export interface ProjectNeighbourReader {
  around(
    ref: string,
    window: { before: number; after: number },
  ): Promise<{ ref: string; at: number; sender: string | null; text: string }[]>
}

export const storedMessageNeighbours = (messages: Pick<MessagesStore, "around">): ProjectNeighbourReader => ({
  async around(ref, window) {
    const at = parseLocator(ref)
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
    if (item.kind !== "message") continue
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
