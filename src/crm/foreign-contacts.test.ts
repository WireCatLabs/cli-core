import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  DAILY_FOREIGN_CONTACTS,
  foreignContacts,
  foreignContactsPathFor,
  refuseForeignClientReads,
} from "./foreign-contacts.js"
import { examplePerson, fakeCrmSource } from "./testing/index.js"

const DAY = Date.UTC(2026, 10, 15, 12)
const fileIn = () => join(mkdtempSync(join(tmpdir(), "crm-foreign-")), "count.json")
const spent = (file: string, count: number) =>
  writeFileSync(
    file,
    JSON.stringify({ day: "2026-11-15", seen: Array.from({ length: count }, (_, at) => `person:old-${at}`) }),
  )

describe("foreign contacts (NEED-2487)", () => {
  it("strips a non-admin's foreign contacts of phones and e-mails, keeping the own clients and the assigned ones", async () => {
    const source = fakeCrmSource({ self: "7", admin: false, ownClients: { person: ["p2"] } })
    const quota = foreignContacts(source, fileIn)
    const people = ["p1", "p2", "p3"].map((id) =>
      examplePerson(id, { email: `${id}@example.com`, phones: ["+100"], ...(id === "p3" ? { assignee: "7" } : {}) }),
    )
    const shown = await quota.strip("person", people)
    expect(shown.map((one) => [one.externalId, one.email ?? null, one.phones ?? null])).toEqual([
      ["p1", null, null],
      ["p2", "p2@example.com", ["+100"]],
      ["p3", "p3@example.com", ["+100"]],
    ])
  })

  it("leaves an administrator and a CRM without isAdmin alone", async () => {
    const people = [examplePerson("p1", { email: "p1@example.com" })]
    for (const source of [fakeCrmSource({ admin: true }), fakeCrmSource()]) {
      const file = fileIn()
      spent(file, DAILY_FOREIGN_CONTACTS)
      const quota = foreignContacts(source, () => file, { now: () => DAY })
      expect(await quota.strip("person", people)).toEqual(people)
      await quota.spend("person", examplePerson("p9"))
    }
  })

  it("spends one slot per foreign record a UTC day, the same one again free, and refuses past the limit", async () => {
    const file = fileIn()
    const quota = foreignContacts(fakeCrmSource({ admin: false }), () => file, { now: () => DAY })
    spent(file, DAILY_FOREIGN_CONTACTS - 1)
    await quota.spend("person", examplePerson("p1"))
    await quota.spend("person", examplePerson("p1"))
    await expect(quota.spend("organization", examplePerson("c1"))).rejects.toMatchObject({
      code: "permission_error",
      details: { reason: "crm.foreign-contacts-spent", limit: DAILY_FOREIGN_CONTACTS },
    })
    const tomorrow = foreignContacts(fakeCrmSource({ admin: false }), () => file, { now: () => DAY + 86_400_000 })
    await tomorrow.spend("organization", examplePerson("c1"))
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ day: "2026-11-16", seen: ["organization:c1"] })
  })

  it("two spends at once never both take the day's last slot (BUG-2)", async () => {
    const file = fileIn()
    spent(file, DAILY_FOREIGN_CONTACTS - 1)
    const quota = () => foreignContacts(fakeCrmSource({ admin: false }), () => file, { now: () => DAY })
    const results = await Promise.allSettled([
      quota().spend("person", examplePerson("p1")),
      quota().spend("person", examplePerson("p2")),
    ])
    expect(results.map((one) => one.status).sort()).toEqual(["fulfilled", "rejected"])
    expect(JSON.parse(readFileSync(file, "utf8")).seen).toHaveLength(DAILY_FOREIGN_CONTACTS)
  })

  it("waits for another run's lock on the count instead of reading past it", async () => {
    const file = fileIn()
    writeFileSync(`${file}.lock`, "")
    const quota = foreignContacts(fakeCrmSource({ admin: false }), () => file, { now: () => DAY, lockWaitMs: 0 })
    await expect(quota.spend("person", examplePerson("p1"))).rejects.toMatchObject({ code: "timeout" })
  })

  it("strips a foreign record's provider_metadata of phones and e-mails too (SEC-2)", async () => {
    const quota = foreignContacts(fakeCrmSource({ admin: false }), fileIn)
    const person = examplePerson("p1", {
      email: "p1@example.com",
      phones: ["+34 600 111 222"],
      metadata: {
        WORK: { label: "Work mail", value: "other@example.org" },
        CELL: { label: "Cell", value: ["+34 (600) 333-444"] },
        SAME: { label: "Copy", value: "+34 600 111 222" },
        SIZE: { label: "Size", value: "12" },
        CODE: { label: "Code", value: "2026-11-15" },
      },
    })
    const [shown] = await quota.strip("person", [person])
    expect(Object.keys(shown?.metadata ?? {})).toEqual(["SIZE", "CODE"])
  })

  it("tells own records from foreign ones without spending a slot", async () => {
    const file = fileIn()
    const quota = foreignContacts(fakeCrmSource({ self: "7", admin: false }), () => file)
    expect(await quota.own("person", examplePerson("p1", { assignee: "7" }))).toBe(true)
    expect(await quota.own("person", examplePerson("p2"))).toBe(false)
    expect(await foreignContacts(fakeCrmSource({ admin: true }), () => file).own("person", examplePerson("p2"))).toBe(
      true,
    )
  })

  it("keeps one day's count per CRM user, so two users of one account never share it (BUG-2)", () => {
    const app = { command: "amo", appName: "amo-cli", envPrefix: "AMO", description: "synthetic", version: "1.0.0" }
    const env = { XDG_STATE_HOME: "/state" }
    const account = { provider: "amo", account: "acme" }
    expect(foreignContactsPathFor(app, account, env, "7")).not.toBe(foreignContactsPathFor(app, account, env, "8"))
    expect(foreignContactsPathFor(app, account, env, "7")).toMatch(/amo-acme-7\.json$/u)
  })

  it("refuses a non-admin's raw client read and lets the rest through (SEC-3)", async () => {
    const limited = fakeCrmSource({ admin: false })
    await expect(refuseForeignClientReads(limited, true, "contacts")).rejects.toMatchObject({
      code: "permission_error",
      details: { reason: "crm.client-reads-admin-only", sent: false },
    })
    await refuseForeignClientReads(limited, false, "contacts/custom_fields")
    await refuseForeignClientReads(fakeCrmSource({ admin: true }), true, "contacts")
    await refuseForeignClientReads(fakeCrmSource(), true, "contacts")
  })
})
