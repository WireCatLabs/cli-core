import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { type ProgramDefinition, run } from "../cli/program.js"
import { settingsFor } from "../cli/settings.js"
import { type AccountKey, openStore } from "../store/store.js"
import { mailReadCommands } from "./cli/index.js"
import { GMAIL_ALL_MAIL } from "./folders.js"
import { ruleInput } from "./rule-input.js"
import { mailCriteriaOf } from "./server-query.js"
import type { MailServerAccess } from "./server-search.js"
import type { MailSource } from "./source.js"
import { type FakeMail, type FakeMailbox, fakeMailSource } from "./testing/index.js"

const app = {
  command: "mail",
  appName: "mail-cli",
  envPrefix: "MAIL",
  description: "A test mail CLI",
  version: "1.0.0",
  messenger: false,
}
const MINE: AccountKey = { provider: "email", account: "me@example.com" }

const fake = (uid: string, day: number, fields: Partial<FakeMail>): FakeMail => ({
  uid,
  messageId: `m${uid}`,
  threadId: `t${uid}`,
  receivedAt: new Date(Date.UTC(2026, 9, day, 9)).toISOString(),
  subject: "Invoice for October",
  from: ["Ann", "ann@example.com"],
  to: [[null, MINE.account]],
  text: "Please pay the invoice by Friday.",
  labels: ["Inbox"],
  ...fields,
})

const setup = async (
  messages: FakeMail[],
  {
    access = {},
    source,
    skipFrom,
    tagFrom,
  }: {
    access?: Partial<MailServerAccess>
    source?: (mailbox: FakeMailbox) => MailSource
    skipFrom?: string
    tagFrom?: { from: string; tags: string[] }
  } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "mail-server-"))
  const env = { MAIL_CONFIG_DIR: join(root, "config"), MAIL_STATE_DIR: join(root, "state") }
  mkdirSync(env.MAIL_CONFIG_DIR, { recursive: true })
  writeFileSync(join(env.MAIL_CONFIG_DIR, "config.json"), JSON.stringify({ profiles: { ya: {} } }))
  const path = join(root, "store.db")
  const store = await openStore({ path })
  const mine = await store.accounts.saveAccount(MINE, { name: null })
  // Synced already: the server finds it too, so it is `both`.
  await store.mail.saveThread({
    accountId: mine,
    externalId: "t1",
    now: Date.UTC(2026, 9, 20),
    emails: [
      {
        externalId: "m1",
        subject: "Invoice for September",
        from: { address: "ann@example.com", name: "Ann" },
        sentAt: null,
        receivedAt: Date.UTC(2026, 8, 3),
        bodyText: "The September invoice is attached.",
        mailboxes: [{ externalId: GMAIL_ALL_MAIL, name: GMAIL_ALL_MAIL, kind: null }],
      },
    ],
  })
  if (skipFrom)
    await store.mail.rules.upsert(
      mine,
      ruleInput({ match: { from: skipFrom }, action: "skip", decided_at: "2026-10-01T00:00:00Z" }),
      1,
    )
  if (tagFrom)
    await store.mail.rules.upsert(
      mine,
      ruleInput({
        match: { from: tagFrom.from },
        action: "keep",
        tags: tagFrom.tags,
        decided_at: "2026-10-01T00:00:00Z",
      }),
      1,
    )
  await store.close()
  const mailbox: FakeMailbox = { messages, queried: [] }
  const definition: ProgramDefinition = {
    app,
    configuration: settingsFor(app),
    commands: () =>
      mailReadCommands({
        app,
        read: async (_command, work) => {
          const opened = await openStore({ path })
          try {
            return await work(opened, MINE)
          } finally {
            await opened.close()
          }
        },
        server: () => ({
          offline: false,
          permissions: {},
          open: async () => ({ source: (source ?? fakeMailSource)(mailbox), folders: [GMAIL_ALL_MAIL] }),
          ...access,
        }),
      }),
  }
  const mail = async (...argv: string[]) => {
    const streams = captureStreams()
    const code = await run(["ya", ...argv], definition, { streams, tty: false, env })
    return { code, out: streams.stdout.join(""), err: streams.stderr.join("") }
  }
  const json = async (...argv: string[]) => {
    const answer = await mail(...argv, "--json")
    expect(answer.code, answer.err).toBe(0)
    return JSON.parse(answer.out)
  }
  const stored = async () => {
    const opened = await openStore({ path })
    try {
      const account = await opened.accounts.storedAccount(MINE)
      return (await opened.mail.emailRefs({ accountId: account?.id as number })).map(({ externalId }) => externalId)
    } finally {
      await opened.close()
    }
  }
  const tagged = async () => {
    const opened = await openStore({ path })
    try {
      return (await opened.tags.tags(MINE)).map(({ messageId, tag }) => [messageId, tag])
    } finally {
      await opened.close()
    }
  }
  return { mail, json, mailbox, stored, tagged }
}

const byRef = (items: { ref: string; found_in?: string }[]) =>
  Object.fromEntries(items.map(({ ref, found_in }) => [decodeURIComponent(ref.split("/").at(-1) as string), found_in]))

describe("mail server search", () => {
  it("stores what the server finds and answers it through the same strict query", async () => {
    const { json, mailbox, stored } = await setup([
      fake("1", 3, { messageId: "m1", threadId: "t1", subject: "Invoice for September" }),
      fake("2", 10, {}),
      // The server's substring match finds "invoices"; the store's word match keeps it, a stem of the same word.
      fake("3", 11, { subject: "Your invoices", text: "Two invoices." }),
      // A substring the strict query does not accept: it is stored, never shown.
      fake("4", 12, { subject: "Reinvoiced", text: "nothing here" }),
    ])
    const found = await json("search", "messages", "invoice", "from:ann")
    expect(byRef(found.items)).toEqual({ m1: "both", m2: "server", m3: "server" })
    expect(found.meta.complete).toBe(true)
    expect(mailbox.queried).toEqual([
      { criteria: expect.objectContaining({ words: ["invoice"], from: ["ann"] }), folder: GMAIL_ALL_MAIL },
    ])
    expect((await stored()).sort()).toEqual(["m1", "m2", "m3", "m4"])
    const again = await json("search", "messages", "invoice", "--backend", "archive")
    expect(byRef(again.items)).toEqual({ m1: undefined, m2: undefined, m3: undefined })
  })

  it("--backend server answers only what the server returned", async () => {
    const { json } = await setup([fake("2", 10, { subject: "Invoice paid", text: "Paid." })])
    const found = await json("search", "messages", "invoice", "--backend", "server")
    expect(byRef(found.items)).toEqual({ m2: "server" })
  })

  it("falls back to the archive with a reason, and --backend server refuses instead", async () => {
    const offline = await setup([fake("2", 10, {})], { access: { offline: true } })
    const both = await offline.json("search", "messages", "invoice", "--backend", "both")
    expect(byRef(both.items)).toEqual({ m1: "archive" })
    expect(both.meta).toMatchObject({
      complete: false,
      issues: [expect.objectContaining({ reason: "search.offline" })],
    })
    expect(offline.mailbox.queried).toEqual([])
    const refused = await offline.mail("search", "messages", "invoice", "--backend", "server", "--json")
    expect(refused.code).not.toBe(0)
    expect(refused.err).toContain("validation_error")

    const denied = await setup([fake("2", 10, {})], { access: { permissions: { "messages.server-search": "deny" } } })
    expect(byRef((await denied.json("search", "messages", "invoice")).items)).toEqual({ m1: undefined })
    const server = await denied.mail("search", "messages", "invoice", "--backend", "server", "--json")
    expect(server.err).toContain("permission_error")
  })

  it("drops what the server answers after the time bound, unsaved", async () => {
    const slow = (mailbox: FakeMailbox): MailSource => ({
      ...fakeMailSource(mailbox),
      query: () => new Promise(() => {}),
    })
    const { json, stored } = await setup([fake("2", 10, {})], { source: slow })
    const found = await json("search", "messages", "invoice", "--server-time", "50ms")
    expect(byRef(found.items)).toEqual({ m1: "archive" })
    expect(found.meta.issues).toEqual([expect.objectContaining({ code: "timeout", reason: "search.server-timeout" })])
    expect(await stored()).toEqual(["m1"])
  })

  it("waits as long as the mailbox's own server time when --server-time is not given", async () => {
    const slow = (mailbox: FakeMailbox): MailSource => ({
      ...fakeMailSource(mailbox),
      query: () => new Promise(() => {}),
    })
    const { json } = await setup([fake("2", 10, {})], { source: slow, access: { timeMs: 50 } })
    const began = Date.now()
    const found = await json("search", "messages", "invoice")
    expect(Date.now() - began).toBeLessThan(4_000)
    expect(found.meta.issues).toEqual([expect.objectContaining({ reason: "search.server-timeout" })])
  })

  it("ends the server's time before the command's deadline, so the search answers in part, not with a timeout", async () => {
    const slow = (mailbox: FakeMailbox): MailSource => ({
      ...fakeMailSource(mailbox),
      query: () => new Promise(() => {}),
    })
    const { mail } = await setup([fake("2", 10, {})], { source: slow })
    const began = Date.now()
    const answer = await mail("search", "messages", "invoice", "--server-time", "60s", "--timeout", "6s", "--json")
    expect(Date.now() - began).toBeLessThan(5_500)
    expect(answer.code, answer.err).toBe(0)
    expect(JSON.parse(answer.out).meta.issues).toEqual([expect.objectContaining({ reason: "search.server-timeout" })])
  })

  it("leaves a find too large to download on the server, and says so", async () => {
    const read: string[] = []
    const big = (mailbox: FakeMailbox): MailSource => {
      const inner = fakeMailSource(mailbox)
      return {
        ...inner,
        list: async (...args) =>
          (await inner.list(...args)).map((item) => (item.uid === "2" ? { ...item, size: 6_000_000 } : item)),
        fetchRaw: async (items) => {
          read.push(...items.map(({ uid }) => uid))
          return inner.fetchRaw(items)
        },
      }
    }
    const { json, stored } = await setup([fake("2", 10, {}), fake("3", 11, {})], { source: big })
    const found = await json("search", "messages", "invoice")
    expect(read).toEqual(["3"])
    expect(byRef(found.items)).toEqual({ m1: "archive", m3: "server" })
    expect(found.meta.issues).toEqual([expect.objectContaining({ reason: "search.server-too-large" })])
    expect((await stored()).sort()).toEqual(["m1", "m3"])
  })

  it("calls a read of the finds that timed out a timeout, not a failed search", async () => {
    const late = (mailbox: FakeMailbox): MailSource => ({
      ...fakeMailSource(mailbox),
      fetchRaw: () => Promise.reject(new CliError("timeout", "the mail server did not answer in time")),
    })
    const { json, stored } = await setup([fake("2", 10, {})], { source: late })
    const found = await json("search", "messages", "invoice")
    expect(byRef(found.items)).toEqual({ m1: "archive" })
    expect(found.meta.issues).toEqual([expect.objectContaining({ code: "timeout", reason: "search.server-timeout" })])
    expect(await stored()).toEqual(["m1"])
  })

  it("tags mail it stores with the owner's rules, since sync never reads it again", async () => {
    const { json, tagged } = await setup([fake("3", 11, {})], {
      tagFrom: { from: "ann@example.com", tags: ["billing"] },
    })
    expect(byRef((await json("search", "messages", "invoice")).items)).toEqual({ m1: "archive", m3: "server" })
    expect(await tagged()).toEqual([["m3", "billing"]])
  })

  it("keeps mail an owner's skip rule leaves out of the store out of it", async () => {
    const { json, stored } = await setup([fake("2", 10, { from: ["Shop", "news@shop.example"] }), fake("3", 11, {})], {
      skipFrom: "news@shop.example",
    })
    expect(byRef((await json("search", "messages", "invoice")).items)).toEqual({ m1: "archive", m3: "server" })
    expect((await stored()).sort()).toEqual(["m1", "m3"])
  })

  it("does not ask the server for a query with nothing it can read", async () => {
    const { json, mailbox } = await setup([fake("2", 10, {})])
    await json("search", "messages", "has:attachment")
    expect(mailbox.queried).toEqual([])
  })
})

describe("mailCriteriaOf", () => {
  it("sends what narrows, one search per OR branch, and leaves the rest to the store", () => {
    const { branches, partial } = mailCriteriaOf(
      '(invoice OR "final notice") subject:october to:me@example.com -spam is:unread date>=2026-10-01',
      { timezone: "UTC" },
    )
    expect(partial).toBe(false)
    expect(branches).toEqual([
      expect.objectContaining({ words: ["invoice"], subject: ["october"], to: ["me@example.com"], seen: false }),
      expect.objectContaining({ words: ["final notice"], subject: ["october"] }),
    ])
    // A server reads whole days in its own zone: one more day on each side.
    expect(branches[0]?.since).toBe(Date.UTC(2026, 8, 30))
    expect(mailCriteriaOf("invoice OR has:attachment").partial).toBe(true)
    expect(mailCriteriaOf("from:me has:attachment").branches).toEqual([])
  })
})
