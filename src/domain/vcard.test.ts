import { describe, expect, it } from "vitest"
import { envelopeOfVcard, isVcard } from "./vcard.js"

const OPTIONS = { provider: "contacts", account: "pixel", batchId: "b-1" }

const cards = (text: string, options = {}) => envelopeOfVcard(text, { ...OPTIONS, ...options })
const people = (text: string, options = {}) =>
  cards(text, options).envelope.records.filter(({ type }) => type === "person")

describe("envelopeOfVcard", () => {
  it("reads a vCard 2.1 card in quoted-printable UTF-8, with a soft break that starts the next line bare", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:2.1",
      "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D0=9F=D0=B5=D1=82=D1=80=D0=BE=D0=B2;=D0=98=D0=B2=",
      "=D0=B0=D0=BD;=D0=A1=D0=B5=D1=80=D0=B3=D0=B5=D0=B5=D0=B2=D0=B8=D1=87;;",
      "TEL;CELL;PREF:+44 (7700) 900-001",
      "TEL;HOME:07700 900002",
      "TEL;WORK;VOICE:+44 7700 900 003",
      "PHOTO;ENCODING=BASE64;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQ",
      " ABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDA",
      "END:VCARD",
    ].join("\r\n")
    const [person] = people(text, { region: "gb" })
    expect(person?.fields).toEqual({
      name: "Иван Сергеевич Петров",
      phone: ["+447700900001", "+447700900002", "+447700900003"],
    })
    expect(cards(text, { region: "gb" }).issues).toEqual([])
  })

  it("decodes a windows-1251 quoted-printable name", () => {
    const text = "BEGIN:VCARD\nVERSION:2.1\nFN;CHARSET=windows-1251;ENCODING=QUOTED-PRINTABLE:=CE=EB=E5=E3\nEND:VCARD\n"
    expect(people(text)[0]?.fields).toEqual({ name: "Олег" })
  })

  it("keeps a national number as text and reports it when no region is given: it is never guessed", () => {
    const text = "BEGIN:VCARD\nVERSION:3.0\nFN:Мария\nTEL;TYPE=CELL:07700 900004\nTEL:+44 7700 900111\nEND:VCARD"
    const { envelope, issues } = cards(text)
    expect(envelope.records[0]?.fields).toEqual({
      name: "Мария",
      phone: ["+447700900111"],
      phone_unread: ["07700 900004"],
    })
    expect(issues).toEqual([{ card: 0, message: expect.stringContaining("no region was given") }])
  })

  it("reads vCard 3.0 folding and escapes, and 4.0's tel: and grouped properties", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "UID:urn:uuid:4fbe8971-0bc3-424c-9c26-36c3e1eff6b1",
      "FN:Анна Иванова\\, ИП",
      'item1.TEL;VALUE=uri;TYPE="voice,cell":tel:+44-7700-900-111;ext=7',
      "EMAIL;TYPE=work:Anna@Example.COM",
      "ORG:ООО Ромашка;Отдел прода",
      " ж",
      "TITLE:Главный бухгалтер",
      "END:VCARD",
    ].join("\n")
    const { envelope } = cards(text)
    expect(envelope.records).toEqual([
      {
        key: "org:ооо ромашка",
        type: "organization",
        external_id: "org:ооо ромашка",
        operation: "upsert",
        fields: { name: "ООО Ромашка" },
      },
      {
        key: "person:urn:uuid:4fbe8971-0bc3-424c-9c26-36c3e1eff6b1",
        type: "person",
        external_id: "urn:uuid:4fbe8971-0bc3-424c-9c26-36c3e1eff6b1",
        operation: "upsert",
        fields: {
          name: "Анна Иванова, ИП",
          phone: ["+447700900111"],
          email: ["anna@example.com"],
          organization: "ООО Ромашка",
          title: "Главный бухгалтер",
        },
        relations: [{ role: "member-of", type: "organization", external_id: "org:ооо ромашка" }],
      },
    ])
  })

  it("gives a card without UID the same id each time, from its name, numbers and addresses", () => {
    const text = "BEGIN:VCARD\nVERSION:3.0\nFN:Олег\nTEL:+447700900333\nEND:VCARD"
    const first = people(text)[0]?.external_id
    expect(first).toMatch(/^vcard:[0-9a-f]{32}$/)
    expect(people(text)[0]?.external_id).toBe(first)
    expect(people(text.replace("333", "999"))[0]?.external_id).not.toBe(first)
  })

  it("leaves out a card that repeats another's UID, and makes one organization for a name several cards share", () => {
    const card = (uid: string, org: string) => `BEGIN:VCARD\nVERSION:3.0\nUID:${uid}\nFN:${uid}\nORG:${org}\nEND:VCARD`
    const { envelope, issues } = cards([card("a", "Ромашка"), card("b", " ромашка"), card("a", "Ромашка")].join("\n"))
    expect(envelope.records.map(({ type, external_id }) => [type, external_id])).toEqual([
      ["organization", "org:ромашка"],
      ["person", "a"],
      ["person", "b"],
    ])
    expect(issues).toEqual([{ card: 2, message: "another card of the file is a: left out" }])
  })

  it("tells a vCard file from a JSON envelope", () => {
    expect(isVcard("﻿BEGIN:VCARD\r\nVERSION:3.0")).toBe(true)
    expect(isVcard('{"schema_version":1}')).toBe(false)
  })

  it("never joins a soft break onto a card's END or past the last line", () => {
    const end = cards(
      "BEGIN:VCARD\nVERSION:2.1\nFN;ENCODING=QUOTED-PRINTABLE:Ab=\nEND:VCARD\nBEGIN:VCARD\nFN:B\nEND:VCARD\n",
    )
    expect(end.envelope.records.map(({ fields }) => fields?.name)).toEqual(["Ab", "B"])
    expect(end.issues).toEqual([])
    const last = cards("BEGIN:VCARD\nVERSION:2.1\nFN;ENCODING=QUOTED-PRINTABLE:Ab=")
    expect(last.envelope.records.map(({ fields }) => fields?.name)).toEqual(["Ab"])
    expect(last.issues).toEqual([{ card: 0, message: "the file ends inside a card, with no END:VCARD" }])
  })

  it("reports a card cut by another BEGIN, an unknown charset and an empty card, and drops none quietly", () => {
    const { envelope, issues } = cards(
      [
        "BEGIN:VCARD\nFN:Outer\nBEGIN:VCARD\nFN:Inner\nEND:VCARD",
        "BEGIN:VCARD\nVERSION:2.1\nFN;CHARSET=X-NOPE;ENCODING=QUOTED-PRINTABLE:A=42\nEND:VCARD",
        "BEGIN:VCARD\nVERSION:3.0\nEND:VCARD",
      ].join("\n"),
    )
    expect(envelope.records.map(({ fields }) => fields?.name)).toEqual(["Outer", "Inner", "AB"])
    expect(issues).toEqual([
      { card: 0, message: "BEGIN:VCARD inside a card: the card ends there, unfinished" },
      { card: 2, message: "FN names the unknown charset x-nope: read as UTF-8" },
      { card: 3, message: "the card holds no name, number or address: left out" },
    ])
  })

  it("hashes a UID too long for an external id, so two long ones stay two cards", () => {
    const card = (uid: string) => `BEGIN:VCARD\nVERSION:3.0\nUID:${uid}\nFN:${uid.slice(-1)}\nEND:VCARD`
    const ids = people([card("u".repeat(600)), card(`${"u".repeat(600)}v`)].join("\n")).map(
      ({ external_id }) => external_id,
    )
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id).toMatch(/^vcard:[0-9a-f]{32}$/)
  })

  it("carries the region as the envelope's phone_region", () => {
    expect(cards("BEGIN:VCARD\nFN:A\nTEL:07700 900111\nEND:VCARD", { region: "gb" }).envelope.options).toEqual({
      phone_region: "gb",
    })
  })
})
