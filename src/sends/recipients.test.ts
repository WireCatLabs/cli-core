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
  it("takes the new id, keeping its title, date and partner", async () => {
    const list = listAt([entry(PHONE, { partnerId: PHONE }), entry("9@lid", { title: "Bo" })])

    expect(await list.rekey(PHONE, LID)).toBe(true)
    expect(list.read()).toEqual([entry(LID, { partnerId: LID }), entry("9@lid", { title: "Bo" })])
    expect(await list.rekey(PHONE, LID)).toBe(false)
    expect(await list.addAsync(entry("5@lid"))).toBe(true)
    expect(await list.addAsync(entry("5@lid"))).toBe(false)
  })

  it("keeps one entry when the list already held both ids", async () => {
    const list = listAt([entry(PHONE), entry(LID)])

    await list.rekey(PHONE, LID)

    expect(list.read()).toEqual([entry(LID)])
  })

  it("adds nothing when the list did not hold the old id, and creates no list that is off", async () => {
    const list = listAt([entry("9@lid")])
    expect(await list.rekey(PHONE, LID)).toBe(false)
    expect(list.read()).toEqual([entry("9@lid")])

    const off = listAt()
    expect(await off.rekey(PHONE, LID)).toBe(false)
    expect(existsSync(off.path)).toBe(false)
  })

  it("leaves a list that cannot be read as it is", async () => {
    const list = listAt()
    writeFileSync(list.path, "{ not json")

    await expect(list.rekey(PHONE, LID)).rejects.toThrow(/cannot be read/)
    expect(readFileSync(list.path, "utf8")).toBe("{ not json")
  })
})

describe("two writers of one recipient list", () => {
  it("does not let a re-key write back a chat the owner removed while it ran", async () => {
    const path = listAt([entry(PHONE), entry("9@lid", { title: "Bo" })]).path
    const owner = new RecipientList(path, "wa", 0)
    let refused: unknown
    class Serve extends RecipientList {
      override read() {
        const chats = super.read()
        if (refused === undefined) {
          try {
            owner.remove("9@lid")
            refused = false
          } catch (error) {
            refused = error
          }
        }
        return chats
      }
    }

    await new Serve(path, "wa").rekey(PHONE, LID)
    expect(refused).toMatchObject({ code: "timeout" })
    expect(owner.remove("9@lid")?.id).toBe("9@lid")

    expect(owner.read()).toEqual([entry(LID)])
  })

  it("refuses a change while another process holds the list, and leaves the file as it was", async () => {
    const list = new RecipientList(listAt([entry(PHONE), entry("9@lid", { title: "Bo" })]).path, "wa", 0)
    const before = readFileSync(list.path, "utf8")
    writeFileSync(`${list.path}.lock`, "")

    expect(() => list.remove("9@lid")).toThrow(expect.objectContaining({ code: "timeout" }))
    await expect(list.rekey(PHONE, LID)).rejects.toThrow(/stayed locked/)
    expect(() => list.add(entry("5@lid"))).toThrow(/stayed locked/)
    await expect(list.addAsync(entry("5@lid"))).rejects.toThrow(/stayed locked/)
    expect(() => list.off()).toThrow(/stayed locked/)
    expect(readFileSync(list.path, "utf8")).toBe(before)
  })
})

it("queries recipients without changing the allowlist or confusing its empty and off states", () => {
  const off = listAt()
  expect(off.list({ id: "7" })).toEqual({ state: "off", items: [] })
  expect(existsSync(off.path)).toBe(false)
  const empty = listAt([])
  expect(empty.list()).toEqual({ state: "empty", items: [] })
  const list = listAt([entry("7"), entry("8", { title: "Bo" })])
  const before = readFileSync(list.path, "utf8")
  expect(list.list({ title: "ana" })).toEqual({ state: "on", items: [entry("7")] })
  expect(list.list({ id: "8", title: "Bo" }).items).toEqual([entry("8", { title: "Bo" })])
  expect(list.list({ id: "7", title: "Bo" })).toEqual({ state: "on", items: [] })
  expect(readFileSync(list.path, "utf8")).toBe(before)
})
