import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { EmailInput } from "./index.js"
import { type MessageStore, openStore } from "./store.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const sent = (id: string, fields: Partial<EmailInput>): EmailInput => ({
  externalId: `<${id}@example.com>`,
  subject: id,
  from: { address: "me@example.com", name: "Me" },
  to: [],
  sentAt: Date.now(),
  receivedAt: Date.now(),
  bodyText: id,
  outgoing: true,
  ...fields,
})

it("answers which addresses the owner wrote to, in To or Cc of live outgoing mail in any account", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "written-to-")), "store.db") })
  stores.push(store)
  const work = await store.accounts.saveAccount({ provider: "email", account: "me@example.com" }, { name: null })
  const home = await store.accounts.saveAccount({ provider: "email", account: "me@home.example" }, { name: null })
  await store.mail.saveThread({
    accountId: work,
    externalId: "t1",
    now: Date.now(),
    emails: [
      sent("to-ann", {
        to: [{ address: "Ann@Example.com", name: "Ann" }],
        cc: [{ address: "cc@example.com", name: null }],
      }),
      sent("bcc-only", { bcc: [{ address: "hidden@example.com", name: null }] }),
      sent("gone", { to: [{ address: "gone@example.com", name: null }] }),
      sent("in", {
        to: [{ address: "in@example.com", name: null }],
        from: { address: "bob@example.com", name: null },
        outgoing: false,
      }),
    ],
  })
  await store.mail.saveThread({
    accountId: home,
    externalId: "t2",
    now: Date.now(),
    emails: [sent("home", { to: [{ address: "friend@example.com", name: null }] })],
  })
  await store.mail.markDeleted(work, ["<gone@example.com>"], Date.now())

  const asked = ["ann@example.com", "CC@example.com", "hidden@example.com", "gone@example.com", "in@example.com"]
  expect(await store.mail.writtenTo([...asked, "friend@example.com", "nobody@example.com"])).toEqual(
    new Set(["ann@example.com", "cc@example.com", "friend@example.com"]),
  )
  expect(await store.mail.writtenTo([])).toEqual(new Set())
})
