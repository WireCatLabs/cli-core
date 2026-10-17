import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { openStore } from "@wirecat/cli-core/store"

const path = process.argv[2]
assert.ok(path && !existsSync(path), "supply a new isolated database path")
const store = await openStore({ path, now: () => 2000 })
try {
  const accountId = await store.accounts.saveAccount(
    { provider: "email", account: "example-work" },
    { name: "Example work" },
  )
  const foreignId = await store.accounts.saveAccount(
    { provider: "email", account: "example-other" },
    { name: "Example other" },
  )
  const input = {
    externalId: "invented-thread",
    now: 2000,
    emails: [
      {
        externalId: "invented-email",
        subject: "Launch update",
        from: { name: "Alice Example", address: "alice@example.test" },
        sentAt: 1000,
        bodyText: "Use the written launch checklist.",
        read: false,
        flagged: false,
      },
    ],
  }
  const saved = await store.mail.saveThread({ ...input, accountId })
  await store.mail.saveThread({ ...input, accountId: foreignId })
  assert.equal(saved.thread.emailsCount, 1)
  assert.equal(saved.thread.lastEmailAt, 1000)
  assert.equal(
    await store.mail.setFlags(accountId, new Map([["invented-email", { read: true, flagged: true }]]), 3000),
    1,
  )
  assert.equal(
    await store.mail.setFlags(accountId, new Map([["invented-email", { read: true, flagged: true }]]), 4000),
    0,
  )
  assert.equal(await store.mail.setFlags(accountId, new Map([["invented-email", {}]]), 5000), 0)
  const email = await store.mail.email(accountId, "invented-email"),
    other = await store.mail.email(foreignId, "invented-email")
  assert.equal(email.read, true)
  assert.equal(email.flagged, true)
  assert.equal(email.updatedAt, 3000)
  assert.equal(other.read, false)
  assert.equal(other.flagged, false)
  assert.equal(await store.mail.markDeleted(accountId, ["invented-email"], 6000), 1)
  const deleted = await store.mail.thread(saved.thread.id)
  assert.equal(deleted.thread.emailsCount, 0)
  assert.equal(deleted.thread.deletedAt, 6000)
  await store.mail.saveThread({ ...input, accountId, now: 7000 })
  const restored = await store.mail.thread(saved.thread.id)
  assert.equal(restored.thread.emailsCount, 1)
  assert.equal(restored.thread.deletedAt, null)
  process.stdout.write(
    `${JSON.stringify({
      node: process.version,
      portable_mail_bindings: true,
      counts_and_deletion: true,
      flag_noop: true,
      account_scope: true,
    })}\n`,
  )
} finally {
  await store.close()
}
