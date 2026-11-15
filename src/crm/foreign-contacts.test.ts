import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DAILY_FOREIGN_CONTACTS, foreignContacts } from "./foreign-contacts.js"
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
    const quota = foreignContacts(fakeCrmSource({ admin: false }), () => file, { now: () => DAY, lockWaitMs: 30 })
    await expect(quota.spend("person", examplePerson("p1"))).rejects.toMatchObject({ code: "timeout" })
  })
})
