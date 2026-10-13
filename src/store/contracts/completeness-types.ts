import type { Id } from "../../domain/models.js"

export interface ChatCompleteness {
  chatId: Id
  /** `unknown` when nothing ever fetched the chat's history: an empty answer then proves nothing. */
  state: "complete" | "partial" | "unknown"
  /** Holds the newest message the chat list knows of; `null` when the list gave no time. */
  upToDate: boolean | null
  /** More than one stretch held, with history missing between them. */
  gaps: boolean
  reachesStart: boolean
  /** When a `messages sync` last read the chat's newest page; `null` when none has. */
  fetchedAt: string | null
}
