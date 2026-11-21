import { describe, expect, it } from "vitest"
import type { ConversationHit } from "../store/store.js"
import { shared } from "./embeddings-search.js"

const hits = (chatId: string, count: number, top: number): ConversationHit[] =>
  Array.from({ length: count }, (_, at) => ({
    summary: { id: `${chatId}-${at}`, chatId } as ConversationHit["summary"],
    chunk: { firstMessageId: "1", lastMessageId: "1" },
    score: top - at * 0.001,
    stale: false,
  }))

describe("shared", () => {
  it("**measures a big group against its 100th best and puts its entries past 20 after every other chat's**", () => {
    const leads = shared([...hits("group", 150, 0.6), ...hits("dialog", 3, 0.45)], 20)
    const lead = (id: string) => leads.find(({ hit }) => hit.summary.id === id)?.lead ?? Number.NaN
    expect(lead("group-0")).toBeCloseTo(0.099)
    expect(
      Math.max(
        ...leads
          .filter(({ hit }) => hit.summary.chatId === "group")
          .slice(20)
          .map((one) => one.lead),
      ),
    ).toBeLessThan(lead("dialog-2"))
    expect(leads.filter(({ hit }) => hit.summary.chatId === "group")).toHaveLength(100)
  })

  it("leads a chat under 100 candidates over its 20th best, as before", () => {
    const leads = shared(hits("group", 60, 0.6), 30)
    expect(leads).toHaveLength(30)
    expect(leads[0]?.lead).toBeCloseTo(0.019)
    expect(leads[25]?.lead).toBeCloseTo(-0.006)
  })
})
