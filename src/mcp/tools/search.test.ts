import { parseLucene } from "@wirecat/cli-base/query"
import * as v from "valibot"
import { describe, expect, it, vi } from "vitest"
import type { Messenger } from "../../cli/messenger/context.js"
import { settingsFor } from "../../cli/settings.js"
import type { SearchFound } from "../../services/messages.js"
import { answerMessagesSearch, messagesSearchInput } from "./search.js"

const found: SearchFound = {
  items: [],
  hasMore: false,
  corrections: [],
  completeness: [],
  wordsReady: true,
  query: { language: "lucene-v1", version: 1, fieldsVersion: 1, presetVersion: 1, timezone: "UTC", order: "relevance" },
  coverage: {
    state: "unknown",
    lastSyncedAt: null,
    inventoryComplete: false,
    accounts: [{ provider: "max", account: "synthetic" }],
    coveredChats: 0,
    messages: 0,
    chats: { complete: 0, partial: 0, neverFetched: 0, behind: 0, withGaps: 0 },
    attention: [],
    next: null,
  },
}

describe.each(["max", "tg"])("the shared MCP search bridge for %s", (command) => {
  const app = { command, appName: "app-cli", envPrefix: "APP", description: "Synthetic CLI", version: "1.0.0" }
  const messenger: Messenger = {
    app,
    provider: command === "max" ? "max" : "telegram",
    chatArgument: "an id or cached title",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => {
      throw new Error("schema must not connect")
    },
  }

  it("accepts short standard text and cached chat names through the same schema", async () => {
    const args = v.parse(messagesSearchInput(messenger), { text: "x", chat: "Synthetic Chat" })
    const search = vi.fn(async () => found)
    const result = await answerMessagesSearch({ search }, args, { limit: 20 })
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ text: "x", chat: "Synthetic Chat", language: "lucene" }),
    )
    expect(result).toEqual({ ...found, page: 1, limit: 20 })
    expect(result.coverage?.state).toBe("unknown")
    expect(result.query?.fieldsVersion).toBe(1)
  })

  it("**forwards exact**, so bare words match their exact form only", async () => {
    const args = v.parse(messagesSearchInput(messenger), { text: "квартира", exact: true })
    const search = vi.fn(async () => found)
    await answerMessagesSearch({ search }, args, { limit: 20 })
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ text: "квартира", exact: true }))
  })

  it("forwards AST/migration/timezone/scopes and cancellation without a second parser", async () => {
    const ast = parseLucene("x")
    const signal = new AbortController().signal
    const args = v.parse(messagesSearchInput(messenger), {
      ast,
      language: "legacy",
      timezone: "Europe/Madrid",
      source: "personal",
      newest: true,
      context: 2,
      limit: 7,
    })
    const search = vi.fn(async () => found)
    const result = await answerMessagesSearch({ search }, args, { limit: 20, signal })
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        ast,
        language: "legacy",
        timezone: "Europe/Madrid",
        source: "personal",
        newest: true,
        context: 2,
        limit: 7,
        signal,
      }),
    )
    expect(search).toHaveBeenCalledOnce()
    expect(result.limit).toBe(7)
    expect(result.completeness).toEqual(found.completeness)
    expect(result.wordsReady).toBe(true)
  })

  it("refuses missing input before calling the search service", async () => {
    const search = vi.fn(async () => found)
    await expect(answerMessagesSearch({ search }, {}, { limit: 20 })).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(search).not.toHaveBeenCalled()
  })

  it("forwards explicit discovery and rejects a non-boolean value", async () => {
    const args = v.parse(messagesSearchInput(messenger), { text: "When is the Helix export?", discover: true })
    const search = vi.fn(async () => found)
    await answerMessagesSearch({ search }, args, { limit: 20 })
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ discover: true }))
    expect(() => v.parse(messagesSearchInput(messenger), { text: "Helix", discover: "yes" })).toThrow()
  })

  it("rejects a language typo in the common schema", () => {
    expect(() => v.parse(messagesSearchInput(messenger), { text: "x", language: "typo" })).toThrow()
  })
})
