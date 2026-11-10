import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openCache } from "../store/open.js"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import { listAccountGroups, setAccountScope, setChatScope } from "./account-groups.js"

const portal: AccountKey = { provider: "bitrix24", account: "acme.bitrix24.ru" }
const phone: AccountKey = { provider: "telegram", account: "101" }
const app = { command: "memo", appName: "scope-test", envPrefix: "MEMO", description: "", version: "0" }

const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})

const opened = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "account-scope-")), "store.db")
  const store = await openStore({ path })
  live.push(store)
  await store.accounts.saveAccount(phone, { name: null })
  await store.chats.saveChats(phone, [
    { id: "room", title: "Synthetic room", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 2 },
  ])
  return { store, path, at: { store, account: phone, app } }
}

const scopeOf = async (store: MessageStore, key: AccountKey) => (await store.accounts.storedAccount(key)).scope

describe("an account's scope", () => {
  it("starts as the CLI's default only when the account is new, and never undoes the owner's choice", async () => {
    const { store } = await opened()
    await store.accounts.saveAccount(portal, { name: null, scope: "work" })
    expect(await scopeOf(store, portal)).toBe("work")
    await store.accounts.saveAccount(phone, { name: null, scope: "work" })
    expect(await scopeOf(store, phone)).toBe("personal")

    await store.accounts.setScope(portal, "personal")
    await store.accounts.saveAccount(portal, { name: null, scope: "work" })
    expect(await scopeOf(store, portal)).toBe("personal")
  })

  it("is set by the owner, and moves the search pieces and word indexes copied from the old one", async () => {
    const { store, path, at } = await opened()
    const database = await openCache(path)
    try {
      const accountId = (await store.accounts.storedAccount(phone)).id
      database
        .prepare(
          "INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, scope, " +
            "account_id, created_at, updated_at) VALUES ('message', 1, 0, 0, 1, 'h', 'personal', ?, 0, 0)",
        )
        .run(accountId)
      database
        .prepare(
          "INSERT INTO documents (account_id, external_id, kind, title, created_at, updated_at) VALUES (?, 'd', 'file', 'Doc', 0, 0)",
        )
        .run(accountId)
      database.prepare("DELETE FROM document_index_pending").run()

      expect(await setAccountScope(at, { member: "telegram:101", scope: "work" })).toMatchObject({
        ...phone,
        scope: "work",
      })
      expect(database.prepare("SELECT scope FROM chunks WHERE chunkable_type = 'message'").get()?.scope).toBe("work")
      expect(database.prepare("SELECT count(*) AS n FROM document_index_pending").get()?.n).toBe(1)
      const work = (await listAccountGroups(at)).groups.all?.find(({ account }) => account === phone.account)
      expect(work?.scope).toBe("work")
    } finally {
      database.close()
    }
  })

  it("refuses a word that is not a scope, an account it does not hold, and a run locked to a group", async () => {
    const { at } = await opened()
    await expect(setAccountScope(at, { member: "telegram:101", scope: "shared" as "work" })).rejects.toThrow(
      expect.objectContaining({ code: "validation_error" }),
    )
    await expect(setAccountScope(at, { member: "telegram:999", scope: "work" })).rejects.toThrow()
    await expect(
      setAccountScope({ ...at, env: { MEMO_GROUP_LOCK: "work" } }, { member: "telegram:101", scope: "work" }),
    ).rejects.toThrow(expect.objectContaining({ code: "permission_error" }))
  })
})

describe("a chat's scope", () => {
  it("is pinned by the owner, recorded as the owner's change, and follows its account again when cleared", async () => {
    const { store, path, at } = await opened()
    expect(await setChatScope(at, { member: "telegram:101", chat: "room", scope: "work" })).toEqual({
      ...phone,
      chat: "room",
      own: "work",
      scope: "work",
    })
    const database = await openCache(path)
    try {
      expect(
        database.prepare("SELECT new_value, source FROM chat_revisions WHERE field = 'scope'").get(),
      ).toMatchObject({ new_value: "work", source: "owner" })
    } finally {
      database.close()
    }
    await setAccountScope(at, { member: "telegram:101", scope: "personal" })
    expect((await store.chats.chatScopes(phone, ["room"])).get("room")).toBe("work")

    expect(await setChatScope(at, { member: "telegram:101", chat: "room", scope: null })).toMatchObject({
      own: null,
      scope: "personal",
    })
  })

  it("refuses a chat the account does not hold", async () => {
    const { at } = await opened()
    await expect(setChatScope(at, { member: "telegram:101", chat: "nowhere", scope: "work" })).rejects.toThrow(
      expect.objectContaining({ code: "not_found" }),
    )
  })
})
