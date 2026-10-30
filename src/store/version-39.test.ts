import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { MIGRATIONS, migrate } from "./migrations.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const owner = { provider: "email", account: "owner@example.test" }
const inbox = { externalId: "INBOX", name: "INBOX", kind: null }
const mail = (externalId: string, location?: number) => ({
  externalId,
  subject: externalId,
  from: null,
  sentAt: null,
  receivedAt: 5_000,
  bodyText: "text",
  mailboxes: [inbox],
  ...(location === undefined ? {} : { locations: [{ folder: "INBOX", uidvalidity: "7", uid: location }] }),
})

it("**a store from before version 39 gains email_locations** and keeps its mail", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "version-39-")), "wirecat.db")
  const old = await openCache(path)
  migrate(old, { migrations: MIGRATIONS.filter(({ version }) => version <= 38), now: () => 1000 })
  old.close()

  const store = await openStore({ path })
  const database = await openCache(path)
  expect(
    database
      .prepare("SELECT name FROM pragma_table_info('email_locations') ORDER BY cid")
      .all()
      .map(({ name }) => name),
  ).toEqual(["mailbox_id", "uidvalidity", "uid", "email_id"])
  expect(database.prepare("SELECT min_compatible FROM schema_migrations WHERE version = 39").get()).toEqual({
    min_compatible: 34,
  })
  database.close()
  await store.close()
})

it("records a location with the email, answers it by folder and UIDVALIDITY, and drops it with the email", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "version-39-")), "wirecat.db") })
  const accountId = await store.accounts.saveAccount(owner, { name: owner.account })
  await store.mail.saveThread({ accountId, externalId: "t1", now: 10, emails: [mail("m1", 11), mail("m2")] })

  expect(await store.mail.folderEmails(accountId, "INBOX", "7")).toMatchObject([
    { uid: 11, externalId: "m1", locations: 1, folders: 1 },
  ])
  expect(await store.mail.folderEmails(accountId, "INBOX", "8")).toEqual([])

  expect(
    await store.mail.setLocations(
      accountId,
      "INBOX",
      "7",
      new Map([
        ["m2", [12, 13]],
        ["nobody", [14]],
      ]),
    ),
  ).toBe(1)
  expect((await store.mail.folderEmails(accountId, "INBOX", "7")).map(({ uid }) => uid)).toEqual([11, 12, 13])

  await store.mail.markDeleted(accountId, ["m2"], 20)
  expect((await store.mail.folderEmails(accountId, "INBOX", "7")).map(({ uid }) => uid)).toEqual([11])
  await store.close()
})

it("forgets a lost UID and takes the email out of the folder once no UID of it is left there", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "version-39-")), "wirecat.db") })
  const accountId = await store.accounts.saveAccount(owner, { name: owner.account })
  await store.mail.saveThread({ accountId, externalId: "t1", now: 10, emails: [mail("m1", 11)] })
  await store.mail.setLocations(accountId, "INBOX", "7", new Map([["m1", [12]]]))

  await store.mail.forgetLocations(accountId, "INBOX", "7", [11])
  expect((await store.mail.email(accountId, "m1"))?.mailboxes).toHaveLength(1)
  await store.mail.forgetLocations(accountId, "INBOX", "7", [12])
  expect((await store.mail.email(accountId, "m1"))?.mailboxes).toEqual([])
  await store.close()
})

it("drops the locations of another UIDVALIDITY when a folder is located again", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "version-39-")), "wirecat.db") })
  const accountId = await store.accounts.saveAccount(owner, { name: owner.account })
  await store.mail.saveThread({ accountId, externalId: "t1", now: 10, emails: [mail("m1", 11)] })

  await store.mail.setLocations(accountId, "INBOX", "8", new Map([["m1", [5]]]))

  expect(await store.mail.folderEmails(accountId, "INBOX", "7")).toEqual([])
  expect((await store.mail.folderEmails(accountId, "INBOX", "8")).map(({ uid }) => uid)).toEqual([5])
  await store.close()
})

it("purges an account that has locations", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "version-39-")), "wirecat.db") })
  const accountId = await store.accounts.saveAccount(owner, { name: owner.account })
  await store.mail.saveThread({ accountId, externalId: "t1", now: 10, emails: [mail("m1", 11)] })

  await store.accounts.purge(owner)

  expect(await store.mail.folderEmails(accountId, "INBOX", "7")).toEqual([])
  await store.close()
})
