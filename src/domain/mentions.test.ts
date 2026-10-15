import { describe, expect, it } from "vitest"
import { findMentions, type MentionKind, telegramTarget } from "./mentions.js"

const values = (text: string, kind: MentionKind) =>
  findMentions(text)
    .filter((one) => one.kind === kind)
    .map(({ value }) => value)

describe("findMentions: phones", () => {
  it.each([
    ["+7 900 000-00-01", "+79000000001"],
    ["+7 (900) 000-00-01", "+79000000001"],
    ["8 (900) 000-00-01", "+79000000001"],
    ["8-900-000-00-01", "+79000000001"],
    ["89000000001", "+79000000001"],
    ["79000000001", "+79000000001"],
    ["9000000001", "+79000000001"],
    ["+1 202 555 0123", "+12025550123"],
    ["+34 600 000 001", "+34600000001"],
    ["(812) 000-00-01", "+78120000001"],
    ["600 000 001", "600000001"],
    ["8 900 000 00 01", "+79000000001"],
  ])("finds %s as %s", (written, value) => {
    expect(values(`звони ${written}, жду`, "phone")).toEqual([value])
    expect(values(`${written}`, "phone")).toEqual([value])
  })

  it("takes a bare number after a phone word", () => {
    expect(values("тел. 3000001", "phone")).toEqual(["3000001"])
    expect(values("WhatsApp: 3000001", "phone")).toEqual(["3000001"])
  })

  it.each([
    "12.10.2026",
    "2026-10-13",
    "10:30",
    "192.168.0.1",
    "1 500 000 руб",
    "100 000 000",
    "$ 9000000001",
    "заказ № 9000000001",
    "ИНН 7800000001",
    "счет 89000000001",
    "4000 0000 0000 0002",
    "v1.2.3",
    "3000001",
    "в 2026 году",
    "1.9000000001",
  ])("finds no phone in %s", (text) => {
    expect(values(text, "phone")).toEqual([])
  })

  it("rates a number with a known country above one without", () => {
    const [known] = findMentions("+7 900 000-00-01")
    const [bare] = findMentions("89000000001")
    const [unknown] = findMentions("тел 3000001")
    expect(known?.confidence).toBeGreaterThan(bare?.confidence ?? 1)
    expect(bare?.confidence).toBeGreaterThan(unknown?.confidence ?? 1)
  })

  it("leaves digits inside a link to the link", () => {
    expect(values("https://wa.me/79000000001", "phone")).toEqual([])
    expect(values("https://example.com/?id=89000000001", "phone")).toEqual([])
  })
})

describe("findMentions: e-mail", () => {
  it("lower-cases the address and names its site", () => {
    expect(findMentions("пиши на <Ivan.Petrov@Mail.Example.co.uk>.")).toEqual([
      expect.objectContaining({ kind: "email", value: "ivan.petrov@mail.example.co.uk", domain: "example.co.uk" }),
    ])
  })

  it("does not take the address's site as a link", () => {
    expect(values("info@example.com", "url")).toEqual([])
  })

  it("finds an address with a Cyrillic domain", () => {
    expect(values("почта@пример.рф", "email")).toEqual(["почта@пример.рф"])
  })
})

describe("findMentions: links", () => {
  it("drops tracking parameters, the fragment and a bare slash", () => {
    expect(values("https://Example.com/?utm_source=tg&fbclid=x", "url")).toEqual(["https://example.com"])
    expect(values("https://example.com/a?b=1&utm_medium=x#top", "url")).toEqual(["https://example.com/a?b=1"])
  })

  it("keeps the sentence's punctuation out and the URL's brackets in", () => {
    expect(values("см. https://example.com/a.", "url")).toEqual(["https://example.com/a"])
    expect(values("(https://en.example.org/wiki/A_(b))", "url")).toEqual(["https://en.example.org/wiki/A_(b)"])
  })

  it.each([
    ["https://docs.google.com/document/d/1x", "google.com"],
    ["https://shop.spb.ru/item", "shop.spb.ru"],
    ["https://a.b.example.co.uk", "example.co.uk"],
    ["https://user.github.io/page", "user.github.io"],
    ["https://пример.рф/страница", "пример.рф"],
  ])("groups %s under %s", (url, domain) => {
    expect(findMentions(url).find((one) => one.kind === "url")?.domain).toBe(domain)
  })

  it("finds a site written without a scheme", () => {
    expect(values("зайди на prokat-med.ru/katalog и www.example.com", "url")).toEqual([
      "https://prokat-med.ru/katalog",
      "https://www.example.com",
    ])
  })

  it.each([
    "readme.md",
    "script.py",
    "т.е.",
    "1.5",
    "file.txt",
    "Mr.Smith",
    "http://192.168.0.1/admin",
    "m := cache.at(i)",
    "first := items.parts[0]",
    "var m sync.Map",
  ])("finds no link in %s", (text) => {
    expect(values(text, "url")).toEqual([])
  })
})

describe("findMentions: documents", () => {
  const ID = "1SyntheticFileId_abc-XYZ0123456789"

  it("gives a Google document link both a link and a document", () => {
    const found = findMentions(`план: https://docs.google.com/document/d/${ID}/edit?usp=sharing`)
    expect(found.map(({ kind, value }) => [kind, value])).toEqual([
      ["url", `https://docs.google.com/document/d/${ID}/edit?usp=sharing`],
      ["document", ID],
    ])
  })

  it("gives no document for another site's /d/ path", () => {
    expect(values(`https://example.com/d/${ID}`, "document")).toEqual([])
  })
})

describe("findMentions: offsets", () => {
  it("points at what was written", () => {
    const text = "Ольга: +7 900 000-00-01 или olga@example.com"
    expect(findMentions(text).map(({ start, end }) => text.slice(start, end))).toEqual([
      "+7 900 000-00-01",
      "olga@example.com",
    ])
  })
})

describe("what a Telegram link names", () => {
  it.each([
    ["https://t.me/book_club", { username: "book_club" }],
    ["https://t.me/s/book_club", { username: "book_club" }],
    ["https://t.me/book_club/42", { username: "book_club" }],
    ["https://t.me/c/1234567890/5", { chatId: "-1001234567890" }],
    ["https://t.me/joinchat/AbCdEf", undefined],
    ["https://t.me/+AbCdEf", undefined],
    ["https://t.me/addstickers/pack", undefined],
    ["https://example.com/book_club", undefined],
  ])("%s", (url, target) => {
    expect(telegramTarget(url)).toEqual(target)
  })
})
