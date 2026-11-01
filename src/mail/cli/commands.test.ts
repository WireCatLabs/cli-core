import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { type ProgramDefinition, run } from "../../cli/program.js"
import { settingsFor } from "../../cli/settings.js"
import type { AttachmentInput, EmailInput } from "../../store/index.js"
import { type AccountKey, openStore } from "../../store/store.js"
import { mailReadCommands } from "./index.js"

const app = {
  command: "mail",
  appName: "mail-cli",
  envPrefix: "MAIL",
  description: "A test mail CLI",
  version: "1.0.0",
  messenger: false,
}
const MINE: AccountKey = { provider: "email", account: "me@example.com" }
const OTHER: AccountKey = { provider: "email", account: "other@example.com" }
const at = (day: number) => Date.UTC(2026, 9, day, 9)

const bill = (text: string): AttachmentInput => ({
  position: 0,
  kind: "file",
  mime: "application/pdf",
  name: "bill.pdf",
  title: null,
  url: null,
  size: 2048,
  width: null,
  height: null,
  duration: null,
  providerRef: { part: 2 },
  localPath: null,
  text,
  normalizedText: null,
  extraction: "text",
  extractor: "pdf:unpdf",
  extractionError: null,
  contentSha256: null,
  extractedAt: at(1),
})

const email = (externalId: string, day: number, fields: Partial<EmailInput>): EmailInput => ({
  externalId,
  subject: "Счёт за октябрь",
  from: { address: "ann@example.com", name: "Ann" },
  to: [{ address: MINE.account, name: null }],
  sentAt: at(day),
  receivedAt: at(day),
  bodyText: "Оплатите счёт до пятницы.",
  ...fields,
})

const seeded = async (storeFails?: Error) => {
  const root = mkdtempSync(join(tmpdir(), "mail-cli-"))
  const env = { MAIL_CONFIG_DIR: join(root, "config"), MAIL_STATE_DIR: join(root, "state") }
  mkdirSync(env.MAIL_CONFIG_DIR, { recursive: true })
  writeFileSync(join(env.MAIL_CONFIG_DIR, "config.json"), JSON.stringify({ profiles: { ya: {} } }))
  const path = join(root, "store.db")
  const store = await openStore({ path })
  const mine = await store.accounts.saveAccount(MINE, { name: null })
  await store.mail.saveThread({
    accountId: mine,
    externalId: "thread-bill",
    now: at(20),
    emails: [
      email("<bill@example.com>", 3, { attachments: [bill("Итого 85,93 € к оплате")] }),
      email("<paid@example.com>", 4, {
        subject: "Re: Счёт за октябрь",
        from: { address: MINE.account, name: "Me" },
        to: [{ address: "ann@example.com", name: "Ann" }],
        bodyText: "Оплатил вчера.",
      }),
    ],
  })
  await store.mail.saveThread({
    accountId: mine,
    externalId: "thread-list",
    now: at(20),
    emails: [
      email("<digest@example.com>", 10, {
        subject: "Weekly digest",
        from: { address: "noreply@github.com", name: "GitHub" },
        bodyText: "New releases this week.",
        headers: { "list-id": "cli-core.wirecatlabs.github.com" },
      }),
    ],
  })
  await store.mail.setSenderScores(
    mine,
    [{ address: "ann@example.com", score: 9, signals: ["lookalike"], demoted: true }],
    at(20),
  )
  const other = await store.accounts.saveAccount(OTHER, { name: null })
  await store.mail.saveThread({
    accountId: other,
    externalId: "thread-other",
    now: at(20),
    emails: [email("<theirs@example.com>", 5, { to: [{ address: OTHER.account, name: null }] })],
  })
  await store.close()
  const definition: ProgramDefinition = {
    app,
    configuration: settingsFor(app),
    commands: () =>
      mailReadCommands({
        app,
        read: async (_command, work) => {
          const opened = await openStore({ path })
          const failing = storeFails && {
            ...opened.accounts,
            storedAccount: () => Promise.reject(storeFails),
          }
          try {
            return await work(
              failing
                ? new Proxy(opened, { get: (store, key) => (key === "accounts" ? failing : Reflect.get(store, key)) })
                : opened,
              MINE,
            )
          } finally {
            await opened.close()
          }
        },
      }),
  }
  const mail = async (...argv: string[]) => {
    const streams = captureStreams()
    const code = await run(["ya", ...argv], definition, { streams, tty: false, env })
    return { code, out: streams.stdout.join(""), err: streams.stderr.join("") }
  }
  const json = async (...argv: string[]) => {
    const answer = await mail(...argv, "--json", "--debug")
    expect(answer.code, answer.err).toBe(0)
    return JSON.parse(answer.out)
  }
  return { mail, json }
}

const BILL = "msg:email/me%40example.com/thread-bill/%3Cbill%40example.com%3E"

describe("mail read commands", () => {
  it("searches the profile's mailbox only, with any form of the word and the shared mail fields", async () => {
    const { json } = await seeded()
    const found = await json("search", "messages", "счета")
    expect(found.items.map((hit: { ref: string }) => hit.ref).sort()).toEqual([
      BILL,
      "msg:email/me%40example.com/thread-bill/%3Cpaid%40example.com%3E",
    ])
    const fromAnn = await json("search", "messages", "счёт from:ann@example.com has:attachment")
    expect(fromAnn.items.map((hit: { ref: string }) => hit.ref)).toEqual([BILL])
    const listed = await json("search", "messages", "list:github.com")
    expect(listed.items).toHaveLength(1)
    expect((await json("search", "messages", "list:other.org")).items).toEqual([])
  })

  it("puts mail from a demoted sender after the rest, and a later page does not show it twice", async () => {
    const { json } = await seeded()
    const page = async (n: string) =>
      (await json("search", "messages", "счёт", "--limit", "1", "--page", n)).items.map(
        (hit: { ref: string }) => hit.ref,
      )
    expect([...(await page("1")), ...(await page("2"))]).toEqual([
      "msg:email/me%40example.com/thread-bill/%3Cpaid%40example.com%3E",
      BILL,
    ])
  })

  it("shows one email whole with its attachment text, and refuses another mailbox's", async () => {
    const { json, mail } = await seeded()
    const shown = await json("messages", "show", BILL)
    expect(shown.item.text).toContain("Оплатите счёт")
    expect(shown.item.attachments[0]).toMatchObject({ name: "bill.pdf", text: "Итого 85,93 € к оплате" })
    const around = await json("messages", "show", BILL, "--after-n", "1")
    expect(around.items).toHaveLength(2)
    const theirs = await mail(
      "messages",
      "show",
      "msg:email/other%40example.com/thread-other/%3Ctheirs%40example.com%3E",
    )
    expect(theirs.code).not.toBe(0)
    expect(theirs.err).toContain("not mail of this profile")
  })

  it("lists threads newest first, filters them by their fields, and shows one oldest first", async () => {
    const { json } = await seeded()
    const all = await json("conversations", "list")
    expect(all.items.map((one: { ref: string }) => one.ref)).toEqual([
      "chat:email/me%40example.com/thread-list",
      "chat:email/me%40example.com/thread-bill",
    ])
    expect(all.items[1]).toMatchObject({ subject: "Счёт за октябрь", emails_count: 2 })
    const replied = await json("conversations", "list", "emails_count>1")
    expect(replied.items.map((one: { ref: string }) => one.ref)).toEqual(["chat:email/me%40example.com/thread-bill"])
    expect((await json("conversations", "list", "subject:счёт")).items).toHaveLength(1)
    const thread = await json("conversations", "show", "chat:email/me%40example.com/thread-bill")
    expect(thread.items.map((one: { text: string }) => one.text)).toEqual([
      expect.stringContaining("Оплатите"),
      expect.stringContaining("Оплатил вчера"),
    ])
    const byEmail = await json("conversations", "show", BILL)
    expect(byEmail.items).toHaveLength(2)
  })

  it("fails conversations when the store fails, rather than answering that nothing is stored", async () => {
    const { mail } = await seeded(new Error("database is locked"))
    for (const argv of [
      ["conversations", "list"],
      ["conversations", "show", BILL],
    ]) {
      const answer = await mail(...argv, "--json")
      expect(answer.code).not.toBe(0)
      expect(answer.err).not.toContain("no stored thread")
    }
  })
})
