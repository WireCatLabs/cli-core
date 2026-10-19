import { describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { SendGuard } from "../sends/guard.js"
import type { MessageStore } from "../store/store.js"
import { adminService } from "./admin.js"
import { onlineDeps } from "./deps.js"

const messenger = { provider: "chat", app: { command: "chat" } } as Messenger
const guard = { check: () => {}, record: () => {} } as unknown as SendGuard
const busy = Object.assign(new Error("database is locked"), { errcode: 5 })

const service = (reads?: "store", store: () => Promise<MessageStore> = async () => brokenStore) => {
  const acted: string[] = []
  const adapter = {
    self: () => "500",
    resolve: async () => ({ id: "7", title: "Book club", kind: "group" }),
    leave: async (chatId: string) => {
      acted.push(`leave ${chatId}`)
      return { chatId }
    },
    join: async () => {
      acted.push("join")
      return { id: "71", title: "Joined", kind: "group" }
    },
  } as unknown as MessengerAdapter
  return { acted, admin: adminService({ ...onlineDeps(messenger, adapter, guard), reads, store }) }
}

const brokenStore = {
  forAccount: () => ({
    chats: {
      chatKind: async () => "group",
      saveChats: async () => {
        throw busy
      },
      rejoinChats: async () => {
        throw busy
      },
    },
  }),
} as unknown as MessageStore

describe("a leave or join whose store record fails", () => {
  it("**says the leave happened and only the mark failed**, not safe to repeat, and how to correct it", async () => {
    const { acted, admin } = service()

    const failed = await admin.leave("Book club").catch((error: unknown) => error)

    expect(acted).toEqual(["leave 7"])
    expect(failed).toMatchObject({
      code: "invalid_response",
      message:
        "you left chat 7, but the local store could not mark it left (database is locked) — do not run it again; " +
        "an online `chat chats list --all` corrects it once the messenger answers it with every chat",
      details: { operation_id: expect.any(String), retryable: false },
    })
  })

  it("**says the join happened** when the left mark cannot come off", async () => {
    const { acted, admin } = service()

    const failed = await admin.join("https://t.me/+abc").catch((error: unknown) => error)

    expect(acted).toEqual(["join"])
    expect(failed).toMatchObject({
      message: expect.stringMatching(/^you joined chat 71, but the local store could not take its left mark off/),
      details: { retryable: false },
    })
  })

  it("**names no command** where the chat list itself comes from the store", async () => {
    const { admin } = service("store")

    await expect(admin.leave("Book club")).rejects.toThrow(
      "do not run it again; this messenger's chat list comes from the store, so no command corrects it",
    )
  })

  it("**reports a store that fails to open** after the leave the same way", async () => {
    const { acted, admin } = service(undefined, async () => {
      throw new Error("disk I/O error")
    })

    await expect(admin.leave("Book club")).rejects.toThrow(
      "you left chat 7, but the local store could not mark it left (disk I/O error)",
    )
    expect(acted).toEqual(["leave 7"])
  })

  it("**succeeds without a store**, which has nothing to mark", async () => {
    const { acted, admin } = service(undefined, onlineDeps(messenger, {} as MessengerAdapter, guard).store)

    await expect(admin.leave("Book club")).resolves.toMatchObject({ chatId: "7" })
    expect(acted).toEqual(["leave 7"])
  })
})
