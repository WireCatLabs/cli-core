import { questions as questionsOf } from "../../questions.js"
import { evidenceOf, excerpt, whoOf } from "../items.js"
import type { StatusItem, StatusSignal } from "../types.js"

export interface QuestionsData {
  /** `theirs`: someone asked and the owner has not answered; `yours`: the owner asked and nobody answered. */
  side: "theirs" | "yours"
  excerpt: string
}

const PER_SIDE = 5
const WEEK = 7 * 86_400_000
const NOBODY = new Set<string>()

/** Open questions both ways, newest first, at most five a side. A question answered in another chat stays open. */
export const questions: StatusSignal<QuestionsData> = {
  id: "questions",
  version: 1,
  scope: "chat",
  read: async (_context, chat) => {
    if (!chat) return []
    const open = (asker: "others" | "owner") =>
      questionsOf(chat.messages, { answerers: NOBODY, asker })
        .filter(({ answer }) => answer === undefined)
        .map(({ question }) => question)
        .reverse()
        .slice(0, PER_SIDE)
    return (
      [
        ["theirs", open("others")],
        ["yours", open("owner")],
      ] as const
    ).flatMap(([side, asked]) =>
      asked.map(
        (question): StatusItem<QuestionsData> => ({
          signal: "questions",
          chat: chat.ref,
          at: question.timestamp,
          who: whoOf(question),
          evidence: evidenceOf(chat, question),
          basis: "store",
          data: { side, excerpt: excerpt(question.text) },
        }),
      ),
    )
  },
  attention: (items, context) => {
    const stale = new Set(
      items.flatMap((item) =>
        item.chat !== null && item.data.side === "yours" && item.at && context.now - Date.parse(item.at) > WEEK
          ? [item.chat]
          : [],
      ),
    )
    return [...stale].map((chat) => ({ chat, weight: 1, why: "your question unanswered for a week" }))
  },
}
