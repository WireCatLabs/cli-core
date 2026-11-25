import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { type AccountKey, openStore } from "./store.js"

const MAIL: AccountKey = { provider: "email", account: "me@acme.example.com" }
const NOW = Date.parse("2026-11-25T12:00:00Z")

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

it("keeps a version 76 store's types as checked, and sorts them by the first rule set after the upgrade", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-77-")), "store.db")
  const store = await openStore({ path })
  const accountId = await store.accounts.saveAccount(MAIL, { name: null })
  await store.mail.saveThreads(
    Array.from({ length: 30 }, (_, n) => ({
      accountId,
      externalId: `t${n}`,
      now: NOW,
      emails: [
        {
          externalId: `<m${n}@acme.example.com>`,
          subject: `Note ${n}`,
          from: { address: `friend${n % 3}@friends.example.com`, name: null },
          to: [{ address: MAIL.account, name: null }],
          sentAt: NOW - n * 60_000,
          receivedAt: NOW - n * 60_000,
          bodyText: null,
        },
      ],
    })),
  )
  await store.close()
  const old = await openCache(path)
  rollBackTo(old, 77)
  old.prepare("UPDATE emails SET mail_type = 'personal', reach = 'direct', type_signal = 'person'").run()
  old.close()

  const upgraded = await openStore({ path })
  handles.push(upgraded)
  const after = await openCache(path)
  handles.push(after)
  expect(after.prepare("SELECT count(*) AS n FROM emails WHERE sort_checked = 1").get()?.n).toBe(30)
  const { rule } = await upgraded.mail.sorting.add(
    { scope: "domain", value: "friends.example.com", mailType: "newsletter", applyTo: "all" },
    "owner",
  )
  expect(await upgraded.mail.emails({ types: ["newsletter"] })).toHaveLength(30)
  expect(after.prepare("SELECT DISTINCT type_signal AS s FROM emails").all()).toEqual([{ s: `rule:${rule?.id}` }])
})
