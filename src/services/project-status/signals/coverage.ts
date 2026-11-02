import type { StatusSignal } from "../types.js"

export interface CoverageData {
  state: "complete" | "partial" | "unknown"
  held: { messages: number; oldestAt: string | null; newestAt: string | null }
  /** The window starts before the oldest message the store holds, so the window is not read whole. */
  beforeHeld: boolean
}

/** What the store holds of a chat it does not hold whole; the answer adds the line that syncs it. */
export const coverage: StatusSignal<CoverageData> = {
  id: "coverage",
  version: 1,
  scope: "chat",
  read: async (context, chat) => {
    if (!chat || chat.coverage.completeness.state === "complete") return []
    const { completeness, held } = chat.coverage
    const oldest = held.oldestAt === null ? null : Date.parse(held.oldestAt)
    return [
      {
        signal: "coverage",
        chat: chat.ref,
        at: completeness.fetchedAt,
        who: null,
        evidence: [],
        basis: "store",
        data: {
          state: completeness.state,
          held,
          beforeHeld: completeness.state !== "complete" && (oldest === null || context.since < oldest),
        },
      },
    ]
  },
  attention: (items) =>
    items.flatMap((item) =>
      item.chat !== null && item.data.state !== "complete" && item.data.beforeHeld
        ? [{ chat: item.chat, weight: 3, why: "held in part" }]
        : [],
    ),
}
