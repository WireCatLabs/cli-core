import type { Missing, NextStep } from "@wirecat/cli-base/standards"
import type { AccountKey, MessageStore, StoredHistorySkip } from "../../store/store.js"
import { nextStep } from "../steps.js"

const SHOWN = 5

const reasonOf = (skip: StoredHistorySkip) =>
  skip.reason === "group_too_large"
    ? `a group of ${skip.members ?? "many"} people, not saved`
    : `only from ${skip.keptFrom?.slice(0, 10) ?? "the window's start"}`

const nameOf = (skip: StoredHistorySkip) => skip.title ?? skip.chatId

/**
 * What the history limits (`history_*` settings) left out of pushed history, as `missing` and `next`: an answer read
 * from the store must not pass for every message the messenger has.
 */
export const historyLimitGaps = (skips: StoredHistorySkip[]): { next: NextStep[]; missing: Missing[] } => {
  const [first] = skips
  if (!first) return { next: [], missing: [] }
  const messages = skips.reduce((sum, skip) => sum + skip.messages, 0)
  const listed = skips
    .slice(0, SHOWN)
    .map((skip) => `${nameOf(skip)} (${skip.messages}, ${reasonOf(skip)})`)
    .join("; ")
  const more = skips.length > SHOWN ? `; and ${skips.length - SHOWN} more — \`store status\` lists them` : ""
  return {
    next: [
      {
        ...nextStep("messages.sync", { args: { chat: first.chatId, full_history: true } }),
        why: "fetches this chat's history and keeps it in full from now on, past the history limits",
      },
    ],
    missing: [
      {
        field: "history_limits",
        why:
          `the history limits (history_* settings) left ${messages} pushed messages of ${skips.length} chats out of ` +
          `the store: ${listed}${more}`,
        step: "messages.sync",
      },
    ],
  }
}

/** What the limits left out in every account an answer read, most messages first. */
export const historySkipsOf = async (
  store: Pick<MessageStore, "chats">,
  accounts: readonly AccountKey[],
): Promise<StoredHistorySkip[]> =>
  (await Promise.all(accounts.map((account) => store.chats.historySkips(account))))
    .flat()
    .sort((a, b) => b.messages - a.messages)
