import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type MessageStore, openStore } from "../store/index.js"
import { decodedLabelName, labelName } from "./labels.js"
import { mailProgress } from "./progress.js"
import { ruleInput } from "./rule-input.js"
import { storedMailRuleSet, storedMailRules } from "./rule-stored.js"
import type { MailRule } from "./rules.js"
import { syncMail } from "./sync.js"
import { fakeMailSource } from "./testing/index.js"

const ME = "owner@example.test"
const KEY = { provider: "email", account: ME }
const opened: MessageStore[] = []
afterEach(async () => {
  for (const each of opened.splice(0)) await each.close()
})

const open = async () => {
  const env = { ...process.env, MESSAGING_STORE: join(mkdtempSync(join(tmpdir(), "mail-shared-")), "messages.db") }
  const store = await openStore({ env })
  opened.push(store)
  return store
}

const rule = (match: MailRule["match"], action: MailRule["action"] = "skip"): MailRule => ({
  match,
  action,
  decided_at: "2026-10-01T00:00:00Z",
})

describe("stored mail rules", () => {
  it("round-trips a rule through the store and leaves out one it cannot read", async () => {
    const store = await open()
    const id = await store.accounts.saveAccount(KEY, { name: ME })
    await store.mail.rules.upsert(id, ruleInput(rule({ domain: "Shop.Example", preset: "newsletters" }, "envelope")), 1)
    await store.mail.rules.upsert(id, { ...ruleInput(rule({ from: "a@x.example" })), conditions: { future: "x" } }, 1)

    const rules = await storedMailRules(store, { address: "Owner@Example.test" })

    expect(rules).toEqual([
      expect.objectContaining({ match: { domain: "shop.example", preset: "newsletters" }, action: "envelope" }),
    ])
  })

  it("names each rule it leaves out and what it does not know", async () => {
    const store = await open()
    const id = await store.accounts.saveAccount(KEY, { name: ME })
    const known = await store.mail.rules.upsert(id, ruleInput(rule({ from: "a@x.example" })), 1)
    const future = await store.mail.rules.upsert(
      id,
      { ...ruleInput(rule({ domain: "y.example" })), conditions: { domain: "y.example", future: "x" } },
      1,
    )

    const set = await storedMailRuleSet(store, { address: ME })

    expect(set.rules.map(({ id }) => id)).toEqual([known.id])
    expect(set.unreadable).toEqual([{ id: future.id, why: "condition future" }])
  })

  it("has no rules for an account the store has not seen", async () => {
    expect(await storedMailRules(await open(), { address: "new@example.test" })).toEqual([])
  })
})

describe("mailProgress", () => {
  it("is empty before the account exists and reads each folder's saved window after a sync", async () => {
    const store = await open()
    expect(await mailProgress(store, KEY)).toEqual([])

    await syncMail(
      fakeMailSource({
        messages: [
          {
            uid: "101",
            messageId: "9001",
            threadId: "9001",
            receivedAt: "2026-09-10T08:00:00Z",
            subject: "Synthetic",
            from: ["Rin Example", "rin@example.test"],
            to: [[null, ME]],
            text: "Synthetic body",
          },
        ],
        quick: true,
        calls: { search: 0, list: 0, fetchRaw: 0, quick: 0 },
        read: [],
      }),
      store,
      {
        account: { address: ME, mode: "imap", folders: ["INBOX"] },
        since: new Date("2026-09-01T00:00:00Z"),
        now: () => Date.parse("2026-10-04T12:00:00Z"),
      },
    )

    expect(await mailProgress(store, KEY)).toEqual([
      expect.objectContaining({ folder: "INBOX", done: 1, total: 1, since: expect.any(String) }),
    ])
  })
})

describe("labelName", () => {
  it("reads system labels with or without the backslash and decodes UTF-7", () => {
    expect(labelName("\\Inbox")).toBe("Inbox")
    expect(labelName("Starred")).toBe("Starred")
    expect(labelName("&BB8EQAQ4BDIENQRC-")).toBe("Привет")
  })

  it("gives the name memo decodes from the wire and the name mail gets decoded from imapflow alike", () => {
    for (const [raw, decoded, name] of [
      ["R&-D-team", "R&D-team", "R&D-team"],
      ["&BCAEMAQxBD4EQgQw-", "Работа", "Работа"],
      ["\\Inbox", "\\Inbox", "Inbox"],
    ]) {
      expect(labelName(raw as string)).toBe(name)
      expect(decodedLabelName(decoded as string)).toBe(name)
    }
  })
})
