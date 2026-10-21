import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { chatChart } from "../../charts/chat.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { servicesFor, storedDeps } from "../../services/index.js"
import { openStore } from "../../store/store.js"
import { seedSearchRecipes } from "../../testing/search-recipes.js"
import { answered, type Defaults, Picture } from "../tool.js"
import { statsTools } from "./stats.js"

const messenger = {
  app: { command: "chat" },
  provider: "chat",
  chatArgument: "a chat",
  connect: async () => {
    throw new Error("chart tool connected")
  },
} as unknown as Messenger
const defaults: Defaults = {
  limit: 20,
  guard: { check: () => {}, record: () => {} },
  env: {},
  settings: { profile: "default", configured: {}, shared: {} },
}
const account = { provider: "chat", account: "500" }

describe("stats_charts", () => {
  it("returns the same neutral data as CLI's builder, entirely from the store", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "chart-tool-")), "m.db") })
    try {
      await seedSearchRecipes(store, account)
      const tool = statsTools(messenger).stats_charts
      if (!tool?.stored) throw new Error("stats_charts is not stored")
      const stats = await servicesFor(storedDeps(messenger, store, account, defaults.guard)).chats.stats("7", {
        by: "day",
        since: Date.parse("2026-01-01"),
        timezone: "UTC",
      })
      expect(
        await tool.stored(store, account, { chat: "7", since_time: "2026-01-01", timezone: "UTC" }, defaults),
      ).toEqual({
        item: chatChart(stats, { by: "day", kind: "messages", timezone: "UTC" }),
        meta: { timezone: "UTC", window: { since: "2026-01-01T00:00:00.000Z" } },
      })
      const image = await tool.stored(
        store,
        account,
        { chat: "7", since_time: "2026-01-01", timezone: "UTC", format: "png" },
        defaults,
      )
      expect(image).toBeInstanceOf(Picture)
      const response = answered(image)
      const content = response.content[0]
      if (content?.type !== "image") throw new Error("missing MCP image")
      expect(content.mimeType).toBe("image/png")
      const png = Buffer.from(content.data, "base64")
      expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([800, 400])
      const about = response.content[1]
      if (about?.type !== "text") throw new Error("missing chart JSON")
      expect(JSON.parse(about.text)).toMatchObject({
        item: chatChart(stats, { by: "day", kind: "messages", timezone: "UTC" }),
        meta: { run_id: expect.any(String) },
      })
      expect(
        await tool.stored(
          store,
          account,
          { chat: "7", chart_kind: "active", by: "week", since_time: "2026-01-01" },
          defaults,
        ),
      ).toMatchObject({ item: { kind: "line", x: { type: "week" } } })
      await expect(tool.stored(store, account, { chat: "7", chart_kind: "membership" }, defaults)).rejects.toThrow(
        "unavailable",
      )
    } finally {
      await store.close()
    }
  })
})
