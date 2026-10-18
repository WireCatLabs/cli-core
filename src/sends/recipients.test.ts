import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type Recipient, RecipientList } from "./recipients.js"

const PHONE = "34600000001@s.whatsapp.net"
const LID = "777@lid"
const listAt = (chats?: Recipient[]) => {
  const path = join(mkdtempSync(join(tmpdir(), "recipients-")), "default.recipients.json")
  if (chats) writeFileSync(path, JSON.stringify({ chats }))
  return new RecipientList(path, "wa")
}
const entry = (id: string, extra: Partial<Recipient> = {}): Recipient => ({
  id,
  title: "Ana",
  addedAt: "2026-10-01T00:00:00.000Z",
  ...extra,
})

describe("a re-keyed chat in the recipient list", () => {
  it("takes the new id, keeping its title, date and partner", () => {
    const list = listAt([entry(PHONE, { partnerId: PHONE }), entry("9@lid", { title: "Bo" })])

    expect(list.rekey(PHONE, LID)).toBe(true)
    expect(list.read()).toEqual([entry(LID, { partnerId: LID }), entry("9@lid", { title: "Bo" })])
    expect(list.rekey(PHONE, LID)).toBe(false)
  })

  it("keeps one entry when the list already held both ids", () => {
    const list = listAt([entry(PHONE), entry(LID)])

    list.rekey(PHONE, LID)

    expect(list.read()).toEqual([entry(LID)])
  })

  it("adds nothing when the list did not hold the old id, and creates no list that is off", () => {
    const list = listAt([entry("9@lid")])
    expect(list.rekey(PHONE, LID)).toBe(false)
    expect(list.read()).toEqual([entry("9@lid")])

    const off = listAt()
    expect(off.rekey(PHONE, LID)).toBe(false)
    expect(existsSync(off.path)).toBe(false)
  })

  it("leaves a list that cannot be read as it is", () => {
    const list = listAt()
    writeFileSync(list.path, "{ not json")

    expect(() => list.rekey(PHONE, LID)).toThrow(/cannot be read/)
    expect(readFileSync(list.path, "utf8")).toBe("{ not json")
  })
})
