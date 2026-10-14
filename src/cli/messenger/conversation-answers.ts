import type { Missing, NextStep } from "@wirecat/cli-base/standards"
import type { Message } from "../../domain/models.js"
import { conversationItem } from "../../services/conversations.js"
import type { ChatReadiness, FoundConversations, Refreshed } from "../../services/embeddings.js"
import type { AccountKey, ConversationSummary } from "../../store/store.js"
import { itemOf, listOf, snakeKeys } from "../envelope.js"
import { nextStep } from "../steps.js"
import { messageItems } from "./message-items.js"

type Readiness = Pick<FoundConversations, "meaning" | "model" | "readiness" | "refreshed" | "coverage">

const chats = (ids: readonly string[]) => `chat ${ids.join(", ")}`

/** What a conversation search could not see, each with the step that fixes it. */
export const readinessGaps = (
  { meaning, model, readiness, refreshed, coverage }: Readiness,
  chat?: string,
): { next: NextStep[]; missing: Missing[] } => {
  const next: NextStep[] = []
  const missing: Missing[] = []
  if (meaning === "unavailable") {
    next.push(nextStep("models.download", { args: { model } }))
    missing.push({
      field: "by",
      why: `${model} is not downloaded, so only words were searched`,
      step: "models.download",
    })
  }
  const unembedded = [...new Set([...readiness.wordsOnly, ...readiness.partial])]
  if (meaning === "searched" && unembedded.length > 0) {
    next.push(nextStep("conversations.embed", { args: { chat: unembedded[0] } }))
    missing.push({
      field: "by",
      why: `not searched by meaning, or only in part, with no vector of ${model}: ${chats(unembedded)}`,
      step: "conversations.embed",
    })
  }
  const unbuilt = [...new Set([...readiness.stale, ...readiness.notBuilt])]
  if (unbuilt.length > 0) {
    next.push(nextStep("conversations.build", { args: { chat: unbuilt[0] } }))
    missing.push({
      field: "items",
      why: `changed since the last build or never built, so their matches may be missing: ${chats(unbuilt)}`,
      step: "conversations.build",
    })
  }
  if (refreshed?.complete === false || coverage !== undefined) {
    next.push(nextStep("messages.sync", { args: chat === undefined ? { all: true, background: true } : { chat } }))
    missing.push({
      field: "coverage",
      why: "the fetch before searching stopped early or the store is behind, so the answer may be stale",
      step: "messages.sync",
    })
  }
  return { next, missing }
}

/** `search conversations` and `conversations related`, CLI and MCP alike. */
export const foundConversations = (
  command: string,
  found: Readiness & Pick<FoundConversations, "hits" | "accounts">,
  limit: number,
  chat?: string,
) =>
  listOf(command, {
    items: found.hits.map((hit) => snakeKeys(hit)),
    limit,
    has_more: false,
    ...readinessGaps(found, chat),
    ...(found.accounts ? { meta: { accounts: found.accounts.map((one) => `${one.provider}:${one.account}`) } } : {}),
  })

/** `conversations status`: each built chat with the model it was measured by; group chats never built are missing. */
export const readinessList = ({
  model,
  chats,
  unbuiltGroups,
}: {
  model: string
  chats: ChatReadiness[]
  unbuiltGroups?: number
}) =>
  listOf("conversations status", {
    items: chats.map((one) => snakeKeys({ ...one, model })),
    limit: Math.max(1, chats.length),
    has_more: false,
    ...(unbuiltGroups
      ? {
          next: [nextStep("conversations.build", { args: {} })],
          missing: [
            {
              field: "items",
              why: `${unbuiltGroups} group chat${unbuiltGroups === 1 ? " was" : "s were"} never built`,
              step: "conversations.build",
            },
          ],
        }
      : {}),
  })

/** A run over many chats: what it built and embedded, and the download it needs when the model is missing. */
export const refreshedAnswer = (refreshed: Refreshed) =>
  itemOf(snakeKeys(refreshed), {
    next:
      !refreshed.modelAvailable &&
      refreshed.embedded.length === 0 &&
      refreshed.left.some((one) => one.needs === "embed")
        ? [nextStep("models.download", { args: { model: refreshed.model } })]
        : [],
  })

/** One conversation and its messages, oldest first. */
export const conversationShown = (
  account: AccountKey,
  { summary, messages }: { summary: ConversationSummary; messages: Message[] },
) => itemOf({ ...conversationItem(account, summary), messages: messageItems(messages, account) })
