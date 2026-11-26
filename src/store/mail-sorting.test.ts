import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { CacheDatabase } from "./driver.js"
import { openCache } from "./open.js"
import type { EmailInput } from "./sqlite/emails.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const MAIL: AccountKey = { provider: "email", account: "owner@home.example.com" }
const NOW = Date.parse("2026-11-25T12:00:00Z")
const DAY = 86_400_000

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

let n = 0
const email = (from: string, subject: string, at = NOW - DAY): EmailInput => {
  n += 1
  return {
    externalId: `<s${n}@test.example.com>`,
    subject,
    from: { address: from, name: from.split("@")[0] ?? null },
    to: [{ address: MAIL.account, name: null }],
    sentAt: at,
    receivedAt: at,
    bodyText: null,
  }
}

interface Opened {
  store: MessageStore
  db: CacheDatabase
  save(emails: EmailInput[]): Promise<void>
}

const opened = async (emails: EmailInput[], now = () => NOW): Promise<Opened> => {
  const path = join(mkdtempSync(join(tmpdir(), "mail-sorting-")), "store.db")
  const store = await openStore({ path, now })
  handles.push(store)
  const accountId = await store.accounts.saveAccount(MAIL, { name: null })
  const save = async (batch: EmailInput[]) => {
    await store.mail.saveThreads(
      batch.map((one) => ({ accountId, externalId: `t-${one.externalId}`, now: NOW, emails: [one] })),
    )
  }
  await save(emails)
  const db = await openCache(path)
  handles.push(db)
  return { store, db, save }
}

const types = async (store: MessageStore) =>
  Object.fromEntries(
    (await store.mail.emails({ limit: 500 })).map((one) => [one.subject, `${one.mailType} ${one.typeSignal}`]),
  )

const idOf = async (store: MessageStore, subject: string) =>
  (await store.mail.emails({ limit: 500 })).find((one) => one.subject === subject)?.id as number

describe("mail sorting rules", () => {
  it("types an address's past mail by the owner's rule, says which rule, and takes it back on removal", async () => {
    const { store } = await opened([
      email("ann@shop.example", "Hello from Ann"),
      email("joann@shop.example", "Hello from Jo"),
    ])
    expect(await types(store)).toEqual({ "Hello from Ann": "personal person", "Hello from Jo": "personal person" })
    const { rule, preview } = await store.mail.sorting.add(
      { scope: "address", value: "Ann@Shop.Example", mailType: "promotion", applyTo: "all" },
      "owner",
    )
    expect(preview).toMatchObject({ label: "every mail from ann@shop.example", emails: 1, retyped: 1, freeMail: false })
    expect(await types(store)).toEqual({
      "Hello from Ann": `promotion rule:${rule?.id}`,
      "Hello from Jo": "personal person",
    })
    expect((await store.mail.emails({ types: ["promotion"] })).map((one) => one.subject)).toEqual(["Hello from Ann"])

    await store.mail.sorting.remove(rule?.id as number, "owner")
    expect(await types(store)).toEqual({ "Hello from Ann": "personal person", "Hello from Jo": "personal person" })
    expect((await store.mail.sorting.rules({ removed: true })).map(({ id }) => id)).toEqual([rule?.id])
  })

  it("leaves past mail alone when the rule is for new mail only", async () => {
    const { store, save } = await opened([email("ann@shop.example", "Before")])
    const { rule } = await store.mail.sorting.add(
      { scope: "address", value: "ann@shop.example", mailType: "newsletter", applyTo: "new" },
      "owner",
    )
    await save([
      email("ann@shop.example", "After", NOW + 60_000),
      email("ann@shop.example", "Backfilled", NOW - 9 * DAY),
    ])
    expect(await types(store)).toEqual({
      Before: "personal person",
      After: `newsletter rule:${rule?.id}`,
      Backfilled: "personal person",
    })
  })

  it("orders scopes and authors: every owner's rule over every program's, then mail, address, domain", async () => {
    const { store } = await opened([
      email("orders@shop.example", "Receipt 1"),
      email("orders@shop.example", "Receipt 2"),
      email("news@mail.shop.example", "Weekly"),
    ])
    const domain = await store.mail.sorting.add(
      { scope: "domain", value: "shop.example", mailType: "promotion", applyTo: "all" },
      "owner",
    )
    const address = await store.mail.sorting.add(
      { scope: "address", value: "orders@shop.example", mailType: "order", applyTo: "all" },
      "owner",
    )
    const program = await store.mail.sorting.add(
      { scope: "address", value: "orders@shop.example", mailType: "bill", applyTo: "all" },
      { bot: "sorter", reason: "learned" },
    )
    const one = await store.mail.sorting.add(
      { scope: "mail", value: await idOf(store, "Receipt 2"), mailType: "shipping", applyTo: "all" },
      "owner",
    )
    expect(program.preview.retyped).toBe(0)
    const programMail = await store.mail.sorting.add(
      { scope: "mail", value: await idOf(store, "Weekly"), mailType: "bill", applyTo: "all" },
      { bot: "sorter", reason: "learned" },
    )
    expect(programMail.preview.retyped).toBe(0)
    expect(await types(store)).toEqual({
      "Receipt 1": `order rule:${address.rule?.id}`,
      "Receipt 2": `shipping rule:${one.rule?.id}`,
      Weekly: `promotion rule:${domain.rule?.id}`,
    })
    await store.mail.sorting.add(
      { scope: "domain", value: "shop.example", mailType: "account_notice", overAddresses: true, applyTo: "all" },
      "owner",
    )
    expect((await types(store))["Receipt 1"]).toMatch(/^account_notice /)
  })

  it("sets a free-mail domain rule only after a dry run, and never widens a correction to it", async () => {
    const { store } = await opened([
      email("ann@gmail.com", "From Ann"),
      email("bob@gmail.com", "From Bob"),
      email("bob@gmail.com", "Bob again"),
    ])
    const scopes = await store.mail.sorting.scopes(await idOf(store, "From Ann"))
    expect(scopes.map(({ scope, freeMail }) => `${scope}${freeMail ? " free-mail" : ""}`)).toEqual([
      "mail",
      "address",
      "domain free-mail",
    ])
    await store.mail.sorting.add(
      { scope: "address", value: "ann@gmail.com", mailType: "promotion", applyTo: "all" },
      "owner",
    )
    expect((await store.mail.sorting.rules()).map(({ scope }) => scope)).toEqual(["address"])
    expect((await types(store))["From Bob"]).toBe("personal person")

    const rule = { scope: "domain", value: "gmail.com", mailType: "newsletter", applyTo: "all" } as const
    await expect(store.mail.sorting.add(rule, "owner")).rejects.toMatchObject({
      details: { reason: "mail-sort.confirm" },
    })
    await expect(
      store.mail.sorting.add(rule, { bot: "sorter", reason: "learned" }, { dryRun: true }),
    ).rejects.toMatchObject({ details: { reason: "mail-sort.free-mail-program" } })
    const dry = await store.mail.sorting.add(rule, "owner", { dryRun: true })
    expect(dry).toMatchObject({ applied: false, preview: { freeMail: true, addresses: 2, emails: 3, retyped: 2 } })
    const listed = await store.mail.sorting.add({ ...rule, value: "seznam.cz" }, "owner", { dryRun: true })
    expect(listed.preview.freeMail).toBe(true)
    expect((await store.mail.sorting.rules()).map(({ scope }) => scope)).toEqual(["address"])
    const set = await store.mail.sorting.add(rule, "owner", { confirm: dry.preview.confirm as string })
    expect(set.applied).toBe(true)
    expect(await types(store)).toEqual({
      "From Ann": expect.stringMatching(/^promotion /),
      "From Bob": `newsletter rule:${set.rule?.id}`,
      "Bob again": `newsletter rule:${set.rule?.id}`,
    })
  })

  it("refuses a stale confirm: the counts it was given for no longer hold", async () => {
    const { store, save } = await opened([email("ann@gmail.com", "From Ann")])
    const rule = { scope: "domain", value: "gmail.com", mailType: "newsletter", applyTo: "all" } as const
    const dry = await store.mail.sorting.add(rule, "owner", { dryRun: true })
    await save([email("cy@gmail.com", "From Cy")])
    await expect(
      store.mail.sorting.add(rule, "owner", { confirm: dry.preview.confirm as string }),
    ).rejects.toMatchObject({ details: { reason: "mail-sort.confirm" } })
  })

  it("moves a domain's senders to bots through moveToBot, keeps an address rule's person, and puts them back", async () => {
    const { store, save } = await opened([
      email("orders@shop.example", "Receipt"),
      email("ann@shop.example", "Hi from Ann"),
    ])
    const person = await store.mail.sorting.add(
      { scope: "address", value: "ann@shop.example", sender: "person", applyTo: "all" },
      "owner",
    )
    const dry = await store.mail.sorting.add(
      { scope: "domain", value: "shop.example", sender: "bot", applyTo: "all" },
      "owner",
      { dryRun: true },
    )
    expect(dry.preview).toMatchObject({ addresses: 2, senders: 1 })
    const bots = await store.mail.sorting.add(
      { scope: "domain", value: "shop.example", sender: "bot", applyTo: "all" },
      "owner",
    )
    const listed = async () =>
      (await store.people.listBots({ limit: 10 })).items.flatMap(({ identities, author }) =>
        identities.map(({ id }) => `${id} ${author}`),
      )
    expect(await listed()).toEqual(["orders@shop.example owner"])

    await save([email("alerts@shop.example", "Disk full")])
    expect((await listed()).sort()).toEqual(["alerts@shop.example owner", "orders@shop.example owner"])

    await store.mail.sorting.remove(bots.rule?.id as number, "owner")
    expect(await listed()).toEqual([])
    expect(person.rule?.sender).toBe("person")
  })

  it("puts a removed rule's senders back with the author they had, so the program sorts them again", async () => {
    const { store, db } = await opened([
      email("noreply@shop.ru", "Receipt"),
      email("ann@shop.ru", "Hi from Ann"),
      email("bo@shop.ru", "Hi from Bo"),
    ])
    await store.people.list({ limit: 100, kind: "all" })
    const bots = async () =>
      Object.fromEntries(
        (await store.people.listBots({ limit: 10 })).items.flatMap(({ identities, author }) =>
          identities.map(({ id }) => [id, author]),
        ),
      )
    expect(await bots()).toEqual({ "noreply@shop.ru": "rules" })
    await store.people.moveToPerson({ provider: "email", id: "bo@shop.ru" }, "owner")
    const lastMove = (address: string) =>
      db
        .prepare(
          "SELECT m.author, m.to_bot_id IS NOT NULL AS bot FROM sender_bot_moves m JOIN identities i ON " +
            "i.id = m.identity_id WHERE i.external_id = ? ORDER BY m.id DESC LIMIT 1",
        )
        .get(address)

    const person = await store.mail.sorting.add(
      { scope: "address", value: "noreply@shop.ru", sender: "person", applyTo: "all" },
      "owner",
    )
    const bot = await store.mail.sorting.add(
      { scope: "address", value: "ann@shop.ru", sender: "bot", applyTo: "all" },
      "owner",
    )
    const bo = await store.mail.sorting.add(
      { scope: "address", value: "bo@shop.ru", sender: "bot", applyTo: "all" },
      "owner",
    )
    expect(await bots()).toEqual({ "ann@shop.ru": "owner", "bo@shop.ru": "owner" })

    expect(await store.mail.sorting.undo("owner")).toMatchObject({ undid: "add", rule: { id: bo.rule?.id } })
    await store.mail.sorting.remove(person.rule?.id as number, "owner")
    await store.mail.sorting.remove(bot.rule?.id as number, "owner")
    expect(await bots()).toEqual({ "noreply@shop.ru": "rules" })
    expect(lastMove("noreply@shop.ru")).toEqual({ author: "rules", bot: 1 })
    expect(lastMove("ann@shop.ru")).toEqual({ author: "rules", bot: 0 })
    expect(lastMove("bo@shop.ru")).toEqual({ author: "owner", bot: 0 })

    db.prepare("UPDATE persons SET kind = NULL").run()
    await store.people.list({ limit: 100, kind: "all" })
    expect(await bots()).toEqual({ "noreply@shop.ru": "rules" })
  })

  it("puts more senders back than one write takes, and finishes a stopped put-back on the next removal", async () => {
    const { store, db } = await opened(Array.from({ length: 120 }, (_, i) => email(`desk${i}@bigshop.ru`, `Note ${i}`)))
    const held = () => Number(db.prepare("SELECT count(*) AS n FROM sender_bot_identities").get()?.n)
    const { rule } = await store.mail.sorting.add(
      { scope: "domain", value: "bigshop.ru", sender: "bot", applyTo: "all" },
      "owner",
    )
    expect(held()).toBe(120)
    db.prepare("UPDATE mail_sort_rules SET removed_at = 1 WHERE id = ?").run(rule?.id as number)
    expect(held()).toBe(120)
    await store.mail.sorting.remove(rule?.id as number, "owner")
    expect(held()).toBe(0)
  })

  it("files a sender under an organization and takes it out again", async () => {
    const { store, db } = await opened([email("orders@shop.example", "Receipt")])
    const organization = Number(
      db
        .prepare(
          "INSERT INTO organizations (kind, name, created_at, updated_at) VALUES ('company', 'Shop', 0, 0) RETURNING id",
        )
        .get()?.id,
    )
    const held = () =>
      db
        .prepare(
          "SELECT oi.method FROM organization_identities oi JOIN identities i ON i.id = oi.identity_id " +
            "WHERE i.external_id = 'orders@shop.example' AND oi.organization_id = ?",
        )
        .all(organization)
        .map((row) => String(row.method))
    const { rule } = await store.mail.sorting.add(
      { scope: "address", value: "orders@shop.example", organization: `organization:${organization}`, applyTo: "all" },
      "owner",
    )
    expect(held()).toEqual(["sort-rule"])
    await store.mail.sorting.remove(rule?.id as number, "owner")
    expect(held()).toEqual([])
  })

  it("undoes the owner's changes newest first, and resets a sender's manual sorting", async () => {
    const { store } = await opened([email("ann@shop.example", "Hello"), email("bo@shop.example", "Hey")])
    const first = await store.mail.sorting.add(
      { scope: "address", value: "ann@shop.example", mailType: "order", applyTo: "all" },
      "owner",
    )
    const second = await store.mail.sorting.add(
      { scope: "address", value: "bo@shop.example", mailType: "bill", applyTo: "all" },
      "owner",
    )
    await store.mail.sorting.remove(first.rule?.id as number, "owner")
    expect(await store.mail.sorting.undo("owner")).toMatchObject({ undid: "remove", rule: { id: first.rule?.id } })
    expect((await types(store)).Hello).toBe(`order rule:${first.rule?.id}`)
    expect(await store.mail.sorting.undo("owner")).toMatchObject({ undid: "add", rule: { id: second.rule?.id } })
    expect(await store.mail.sorting.undo("owner")).toMatchObject({ undid: "add", rule: { id: first.rule?.id } })
    expect(await store.mail.sorting.undo("owner")).toBeNull()
    expect(await types(store)).toEqual({ Hello: "personal person", Hey: "personal person" })
    await expect(store.mail.sorting.undo({ bot: "sorter", reason: "x" })).rejects.toMatchObject({
      details: { reason: "mail-sort.owner-only" },
    })

    const address = await store.mail.sorting.add(
      { scope: "address", value: "ann@shop.example", mailType: "order", applyTo: "all" },
      "owner",
    )
    const one = await store.mail.sorting.add(
      { scope: "mail", value: await idOf(store, "Hello"), mailType: "bill", applyTo: "all" },
      "owner",
    )
    const domain = await store.mail.sorting.add(
      { scope: "domain", value: "shop.example", mailType: "promotion", applyTo: "all" },
      "owner",
    )
    const removed = await store.mail.sorting.reset("ann@shop.example", "owner")
    expect(removed.map(({ id }) => id).sort()).toEqual([address.rule?.id, one.rule?.id].sort())
    expect((await store.mail.sorting.rules()).map(({ id }) => id)).toEqual([domain.rule?.id])
    expect((await types(store)).Hello).toBe(`promotion rule:${domain.rule?.id}`)
  })

  it("refuses what a rule cannot do", async () => {
    const { store } = await opened([email("ann@shop.example", "Hello")])
    const add = (
      input: Parameters<MessageStore["mail"]["sorting"]["add"]>[0],
      by: "owner" | { bot: string; reason: string } = "owner",
    ) => store.mail.sorting.add(input, by)
    const reasons = await Promise.all(
      [
        add({ scope: "address", value: "ann@shop.example", applyTo: "all" }),
        add({ scope: "address", value: "ann@", mailType: "order", applyTo: "all" }),
        add({ scope: "subject", value: "sale", sender: "bot", applyTo: "all" }),
        add({ scope: "address", value: "ann@shop.example", sender: "bot", applyTo: "new" }),
        add({ scope: "address", value: "ann@shop.example", sender: "bot", applyTo: "all" }, { bot: "x", reason: "y" }),
        add({ scope: "address", value: "ann@shop.example", mailType: "order", overAddresses: true, applyTo: "all" }),
        add({ scope: "address", value: "ann@shop.example", organization: "organization:999", applyTo: "all" }),
      ].map((call) =>
        call.then(
          () => "set",
          (error) => String(error.details?.reason),
        ),
      ),
    )
    expect(reasons).toEqual([
      "mail-sort.no-action",
      "mail-sort.value",
      "mail-sort.sender-scope",
      "mail-sort.sender-new",
      "mail-sort.owner-only",
      "mail-sort.over-addresses",
      "mail-sort.organization",
    ])
  })

  it("types again what a build before version 77 typed without the rules", async () => {
    const { store, db } = await opened([email("ann@shop.example", "Hello")])
    const { rule } = await store.mail.sorting.add(
      { scope: "address", value: "ann@shop.example", mailType: "order", applyTo: "all" },
      "owner",
    )
    expect(await store.mail.emails({ types: ["order"] })).toHaveLength(1)
    db.prepare("UPDATE emails SET subject = 'Hello again'").run()
    expect(db.prepare("SELECT sort_checked FROM emails").get()?.sort_checked).toBeNull()
    db.prepare("UPDATE emails SET mail_type = 'personal', reach = 'direct', type_signal = 'person'").run()
    expect((await store.mail.emails({ types: ["order"] })).map((one) => one.typeSignal)).toEqual([`rule:${rule?.id}`])
    expect(db.prepare("SELECT sort_checked FROM emails").get()?.sort_checked).toBe(1)
  })
})
