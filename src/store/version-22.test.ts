import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

it("**a store from before version 22 keeps its mail** and takes a demoted sender after the upgrade", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-22-")), "wirecat.db")
  const store = await openStore({ path })
  const accountId = await store.accounts.saveAccount(
    { provider: "email", account: "owner@example.com" },
    { name: null },
  )
  await store.mail.saveThread({
    accountId,
    externalId: "t1",
    now: 1,
    emails: [
      {
        externalId: "<one@example.com>",
        subject: "Deals",
        from: { address: "deals@shop.example", name: null },
        to: [],
        cc: [],
        sentAt: 1,
        receivedAt: 1,
        references: [],
        bodyText: "Synthetic offer",
        outgoing: false,
        read: false,
        mailboxes: [],
      },
    ],
  })
  await store.close()

  const database = await openCache(path)
  rollBackTo(database, 22)
  database.close()

  const upgraded = await openStore({ path })
  expect(await upgraded.mail.emailFacts({ accountId })).toHaveLength(1)
  expect(
    await upgraded.mail.setSenderScores(
      accountId,
      [{ address: "deals@shop.example", score: 3, signals: [], demoted: true }],
      2,
    ),
  ).toBe(1)
  await upgraded.close()
})
