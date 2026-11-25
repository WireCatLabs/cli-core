import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type MessageStore, openStore } from "../store/index.js"
import { syncMail } from "./sync.js"
import { type FakeMail, fakeMailSource } from "./testing/index.js"

// Subdomains of example.com are reserved but are not test data to the store, so these senders get a real kind.
const ME = "owner@home.example.com"
const NOW = Date.parse("2026-10-04T12:00:00Z")
const SINCE = new Date("2026-09-01T00:00:00Z")

let n = 0
const mail = (from: [string, string], overrides: Partial<FakeMail> = {}): FakeMail => {
  n += 1
  return {
    uid: String(100 + n),
    messageId: String(9000 + n),
    threadId: String(9000 + n),
    receivedAt: `2026-09-${String(10 + (n % 15)).padStart(2, "0")}T08:00:00Z`,
    subject: `Synthetic subject ${n}`,
    from,
    to: [[null, ME]],
    text: `Synthetic body ${n}`,
    ...overrides,
  }
}

/** Gmail's stamp for a passing signature of `domain` that covers `fields`. */
const signed = (domain: string, fields: string[]) => [
  `DKIM-Signature: v=1; a=rsa-sha256; d=${domain}; s=s1; h=from:to:subject:${fields.join(":")}; b=abc`,
  `Authentication-Results: mx.google.com; dkim=pass header.i=@${domain} header.s=s1 header.b=abc`,
]

const opened: MessageStore[] = []
afterEach(async () => {
  for (const each of opened.splice(0)) await each.close()
})

const synced = async (messages: FakeMail[]) => {
  const env = { ...process.env, MESSAGING_STORE: join(mkdtempSync(join(tmpdir(), "sender-signals-")), "store.db") }
  const store = await openStore({ env })
  opened.push(store)
  await syncMail(fakeMailSource({ messages }), store, { account: { address: ME }, since: SINCE, now: () => NOW })
  const { items } = await store.people.list({ kind: "all", limit: 100 })
  const bots = (await store.people.listBots({ limit: 100 })).items.map(({ identities, reason, reach, signals }) => [
    identities[0]?.id,
    { kind: "bot", kindSignals: reason?.split(", ") ?? [], reach, signals },
  ])
  return Object.fromEntries([
    ...items
      .filter(({ owner }) => !owner)
      .map(({ email, kind, kindSignals, reach, signals }) => [email, { kind, kindSignals, reach, signals }]),
    ...bots,
  ])
}

describe("a sender's signals from mail headers", () => {
  it("calls a sender automated by an Auto-Submitted or an empty Return-Path its own domain vouches for", async () => {
    const people = await synced([
      mail(["Bank Statements", "statements@bank.example.com"], {
        extraHeaders: ["Auto-Submitted: auto-generated", ...signed("mail.bank.example.com", ["auto-submitted"])],
      }),
      mail(["Ola Brandt", "ola@forged.example.com"], {
        extraHeaders: ["Auto-Submitted: auto-generated", ...signed("relay.example.org", ["auto-submitted"])],
      }),
      mail(["Hosting", "system@hosting.example.com"], { extraHeaders: ["Return-Path: <>"] }),
      mail(["Pia Lund", "pia@office.example.com"], {
        extraHeaders: [
          "Return-Path: <>",
          "Auto-Submitted: auto-replied",
          ...signed("office.example.com", ["auto-submitted"]),
        ],
      }),
    ])

    expect(people["statements@bank.example.com"]).toMatchObject({
      kind: "bot",
      kindSignals: ["auto-submitted"],
      signals: ["auto-submitted"],
      reach: "direct",
    })
    expect(people["ola@forged.example.com"]).toMatchObject({ kind: "stranger", signals: [] })
    expect(people["system@hosting.example.com"]).toMatchObject({ kind: "bot", kindSignals: ["null-return-path"] })
    expect(people["pia@office.example.com"]).toMatchObject({ kind: "stranger", signals: [] })
  })

  it("tells a newsletter, a discussion list, a large group and undisclosed recipients from mail written to the owner", async () => {
    const list = "talk.lists.example.com"
    const crowd = Array.from({ length: 11 }, (_, at): [null, string] => [null, `guest${at}@crowd.example.com`])
    const people = await synced([
      mail(["Weekly News", "news@letters.example.com"], {
        extraHeaders: [
          "List-Unsubscribe: <https://letters.example.com/u>",
          "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
          ...signed("letters.example.com", ["list-unsubscribe", "list-unsubscribe-post"]),
        ],
      }),
      mail(["Ann Ode", "ann@one.example.com"], { listId: list }),
      mail(["Ben Ode", "ben@two.example.com"], { listId: list }),
      mail(["Cyd Ode", "cyd@three.example.com"], { listId: list }),
      mail(["Dag Moe", "dag@crowd.example.com"], { to: crowd }),
      mail(["Eli Moe", "eli@quiet.example.com"], { to: [] }),
      mail(["Fay Moe", "fay@direct.example.com"]),
    ])

    expect(people["news@letters.example.com"]).toMatchObject({ reach: "broadcast", signals: ["one-click-unsubscribe"] })
    expect(people["ann@one.example.com"]).toMatchObject({ reach: "group", signals: ["discussion-list"] })
    expect(people["dag@crowd.example.com"]).toMatchObject({ reach: "group", signals: ["many-recipients"] })
    expect(people["eli@quiet.example.com"]).toMatchObject({ reach: "broadcast", signals: ["undisclosed-recipients"] })
    expect(people["fay@direct.example.com"]).toMatchObject({ kind: "stranger", reach: "direct", signals: [] })
  })

  it("keeps a sender the owner wrote to a person, and direct, whatever their headers say", async () => {
    const people = await synced([
      mail(["Gus Holm", "gus@firm.example.com"], {
        extraHeaders: ["Auto-Submitted: auto-generated", ...signed("firm.example.com", ["auto-submitted"])],
      }),
      mail(["Owner", ME], { to: [["Gus Holm", "gus@firm.example.com"]], labels: ["Sent"] }),
    ])

    expect(people["gus@firm.example.com"]).toMatchObject({ kind: "person", reach: "direct" })
  })
})
