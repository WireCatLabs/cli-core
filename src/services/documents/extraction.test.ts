import { describe, expect, it, vi } from "vitest"
import { extractMemories } from "./extraction.js"

const text = "Budget approved. Use the shared document store."
const answer = (items: unknown[]) => ({
  text: JSON.stringify({ items }),
  tokens: 20,
  provider: "openai",
  model: "fixture-model",
})
describe("source-grounded memory extraction", () => {
  it("accepts exact evidence quotes and uses the shared model request contract", async () => {
    const complete = vi.fn(async () =>
      answer([{ kind: "fact", body: "Use shared storage", quote: "shared document store" }]),
    )
    expect(await extractMemories(text, complete)).toMatchObject({ items: [{ kind: "fact" }], model: "fixture-model" })
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "memories", allowSourceQuotes: true, data: text, maxTokens: 6000 }),
    )
  })
  it.each([
    answer([{ kind: "fact", body: "Unsupported", quote: "Invented source text" }]),
    answer([{ kind: "invented", body: "Unsupported", quote: "shared document store" }]),
    { ...answer([]), text: "not JSON with fixture-secret" },
    answer(Array.from({ length: 21 }, () => ({ kind: "fact", body: "Repeated", quote: "shared document store" }))),
  ])("rejects ungrounded, malformed or unbounded responses", async (result) => {
    await expect(extractMemories(text, async () => result)).rejects.toThrow("no memories were saved")
  })
  it("rejects oversized/empty input before calling a model", async () => {
    const complete = vi.fn(async () => answer([]))
    await expect(extractMemories(" ", complete)).rejects.toThrow("50000")
    await expect(extractMemories("a".repeat(50001), complete)).rejects.toThrow("50000")
    expect(complete).not.toHaveBeenCalled()
  })
})
