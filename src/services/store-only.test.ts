import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { type MessageStore, openStore } from "../store/store.js"
import { conversationsService } from "./conversations.js"
import { storeOnlyDeps } from "./deps.js"
import * as services from "./index.js"

const app = { command: "memo", appName: "cli-memo", envPrefix: "MEMO", description: "notes", version: "0.0.0" }
const notes = { provider: "notes", account: "/vault" }

const note = (id: string, text: string, minute: number): Message => ({
  id,
  chatId: "Projects",
  senderId: null,
  senderName: null,
  timestamp: new Date(Date.parse("2026-10-01T00:00:00Z") + minute * 60_000).toISOString(),
  editedAt: null,
  text,
  outgoing: true,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

let store: MessageStore

beforeEach(async () => {
  store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "store-only-")), "m.db") })
  await store.messages.saveMessages(
    notes,
    "Projects",
    [note("Projects/a.md", "harbour plan", 0), note("Projects/b.md", "lighthouse budget", 1)],
    { via: "test" },
  )
})

afterEach(async () => {
  await store.close()
})

describe("storeOnlyDeps", () => {
  it("builds a program's own stored chat, one conversation per message that has no sender", async () => {
    const built = await conversationsService(storeOnlyDeps(store, notes, { app })).build("Projects")

    expect(built).toMatchObject({ chat: "Projects", messages: 2, conversations: 2 })
  })

  it("never connects and refuses every send", async () => {
    const deps = storeOnlyDeps(store, notes, { app })

    await expect(deps.connection()).rejects.toThrow()
    expect(() => deps.guard.check({ action: "send", chat: "Projects" } as never)).toThrow("no messenger")
  })

  it("is exported with person context, for programs that join other sources", () => {
    expect(typeof services.storeOnlyDeps).toBe("function")
    expect(typeof services.personContext).toBe("function")
    expect(typeof services.identityIn).toBe("function")
  })
})
