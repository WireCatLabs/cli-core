import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type AccountKey, openStore } from "../store/store.js"
import { chatAmong } from "./message-resolution.js"

const OWNER: AccountKey = { provider: "max", account: "1" }
const OTHER: AccountKey = { provider: "max", account: "2" }
const group = (id: string, title: string, membershipState: "member" | "left") => ({
  id,
  title,
  kind: "group" as const,
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
  membershipState,
})

describe("a --chat over several accounts", () => {
  it("finds a chat the owner left when no account still holds one by that name, as one account does", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "resolution-")), "m.db") })
    await store.chats.saveChats(OWNER, [group("-1", "Old group", "left"), group("-2", "Book club", "member")])
    await store.chats.saveChats(OTHER, [group("-3", "Book club archive", "left")])

    expect(await chatAmong({}, store, [OWNER], "Old group")).toEqual({ account: OWNER, chatId: "-1" })
    expect(await chatAmong({}, store, [OWNER, OTHER], "Old group")).toEqual({ account: OWNER, chatId: "-1" })
    expect(await chatAmong({}, store, [OWNER, OTHER], "Book club")).toEqual({ account: OWNER, chatId: "-2" })
    await store.close()
  })
})
