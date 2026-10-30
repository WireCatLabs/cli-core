import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, it } from "vitest"
import { type MessageStore, openStore } from "../../store/index.js"
import { CONTRACT_MAIL, type FakeMailbox, fakeMailSource, mailSourceContract, mailSyncContract } from "./index.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const mailbox = (): FakeMailbox => ({ messages: structuredClone(CONTRACT_MAIL) })

describe("fake mail source", () => {
  for (const c of mailSourceContract(() => fakeMailSource(mailbox()))) it(c.name, c.run)
})

describe("fake mail source without a cheap message id", () => {
  for (const c of mailSourceContract(() => fakeMailSource({ ...mailbox(), quick: true }))) it(c.name, c.run)
  for (const c of mailSyncContract(async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "mail-contract-")), "wirecat.db") })
    opened.push(store)
    return { source: fakeMailSource({ ...mailbox(), quick: true }), store }
  }))
    it(c.name, c.run)
})

describe("sync engine over the fake mail source", () => {
  for (const c of mailSyncContract(async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "mail-contract-")), "wirecat.db") })
    opened.push(store)
    return { source: fakeMailSource(mailbox()), store }
  }))
    it(c.name, c.run)
})
