import type { StoredEvidencePacket } from "../../services/evidence-read.js"
import type { ThreadContext } from "../../services/thread-context.js"
import type { Heard } from "../../speech/transcribe.js"
import type { AccountKey } from "../../store/store.js"
import { itemOf, snakeKeys } from "../envelope.js"
import { nextStep } from "../steps.js"
import { messageItems } from "./message-items.js"

/**
 * The packet as one item; its fingerprints were taken over the library's own field names and stay valid as ids.
 * Older messages are `page.next`, whose cursor is the id the packet stopped before.
 */
export const evidenceAnswer = ({ nextBeforeId, ...packet }: StoredEvidencePacket, chat: string, limit: number) =>
  itemOf(snakeKeys(packet), {
    ...(nextBeforeId === null
      ? {}
      : {
          next: [
            nextStep("page.next", {
              command: "messages evidence",
              args: { chat, cursor: nextBeforeId, limit },
              values: { shown: packet.items.length },
            }),
          ],
        }),
  })

/** A transcript the messenger has not finished is asked for again later; its step says so. */
export const heardAnswer = (heard: Heard, chat: string) =>
  itemOf(
    snakeKeys(heard),
    heard.pending ? { next: [nextStep("messages.transcribe", { args: { chat, message: heard.messageId } })] } : {},
  )

/** `messages context --thread`: the thread's own fields snake_case, its messages as `message` items. */
export const threadAnswer = ({ items, ...thread }: ThreadContext, reader: AccountKey) =>
  itemOf({ ...(snakeKeys(thread) as object), items: messageItems(items, reader) })
