import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { afterEach, describe, expect, it } from "vitest"
import { runBudget } from "../background/budget.js"
import { formatLocator } from "../domain/locator.js"
import { type MessageStore, openStore } from "../store/index.js"
import { type ResumePoint, resumeKey } from "./resume.js"
import type { MailRule } from "./rules.js"
import type { MailSource } from "./source.js"
import { type MailSyncOptions, syncMail } from "./sync.js"
import { type FakeMail, type FakeMailbox, fakeArchiveSource, fakeMailSource } from "./testing/index.js"

const ME = "owner@example.test"
const KEY = { provider: "email", account: ME }
const NOW = Date.parse("2026-10-04T12:00:00Z")
const SINCE = new Date("2026-09-01T00:00:00Z")

const mail = (n: number, overrides: Partial<FakeMail> = {}): FakeMail => ({
  uid: String(100 + n),
  messageId: String(9000 + n),
  threadId: String(9000 + n),
  receivedAt: `2026-09-${String(10 + n).padStart(2, "0")}T08:00:00Z`,
  subject: `Synthetic subject ${n}`,
  from: ["Rin Example", "rin@example.test"],
  to: [[null, ME]],
  text: `Synthetic body ${n}`,
  ...overrides,
})

const opened: MessageStore[] = []
const boxes = new Map<NodeJS.ProcessEnv, FakeMailbox>()

const setup = (messages: FakeMail[], extra: Omit<FakeMailbox, "messages"> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "mail-"))
  const env = { ...process.env, MESSAGING_STORE: join(dir, "messages.db") }
  const box: FakeMailbox = { messages, ...extra }
  boxes.set(env, box)
  const write = (next: FakeMail[], more: Omit<FakeMailbox, "messages"> = {}) => {
    for (const key of Object.keys(box)) delete (box as unknown as Record<string, unknown>)[key]
    Object.assign(box, { messages: next, ...extra, ...more })
  }
  return { dir, env, write, box }
}

const sourceOf = (env: NodeJS.ProcessEnv): MailSource => fakeMailSource(boxes.get(env) as FakeMailbox)

const importMail = ({ store, source, ...options }: MailSyncOptions & { store: MessageStore; source: MailSource }) =>
  syncMail(source, store, options)

const store = async (env: NodeJS.ProcessEnv) => {
  const opening = await openStore({ env })
  opened.push(opening)
  return opening
}

const importInto = async (env: NodeJS.ProcessEnv, max?: number) =>
  importMail({
    store: await store(env),
    source: sourceOf(env),
    account: { address: ME },
    since: SINCE,
    now: () => NOW,
    ...(max === undefined ? {} : { max }),
  })

const emails = async (env: NodeJS.ProcessEnv) => {
  const opening = await store(env)
  return opening.mail.emails({ accountId: (await opening.accounts.storedAccount(KEY)).id })
}

afterEach(async () => {
  for (const each of opened.splice(0)) await each.close()
  boxes.clear()
})

describe("syncMail", () => {
  it("saves each mail as an email of its Gmail thread, with sender, recipients and body", async () => {
    const { env } = setup([
      mail(1),
      mail(2, {
        threadId: "9001",
        from: [null, ME],
        to: [["Rin Example", "rin@example.test"]],
        subject: "Re: Synthetic subject 1",
      }),
    ])

    const result = await importInto(env)

    expect(result).toMatchObject({ listed: 2, saved: 2, alreadyStored: 0, deleted: 0, complete: true })
    const saved = await emails(env)
    expect(saved.map(({ externalId, outgoing, subject }) => ({ externalId, outgoing, subject }))).toEqual([
      { externalId: "9002", outgoing: true, subject: "Re: Synthetic subject 1" },
      { externalId: "9001", outgoing: false, subject: "Synthetic subject 1" },
    ])
    expect(saved[1]).toMatchObject({ bodyText: "Synthetic body 1", fromAddress: "rin@example.test" })
    expect(saved[1]?.mailboxes.map(({ externalId }) => externalId)).toEqual(["[Gmail]/All Mail"])
    const opening = await store(env)
    const [thread] = await opening.mail.threads({ accountId: (await opening.accounts.storedAccount(KEY)).id })
    expect(thread).toMatchObject({ externalId: "9001", subject: "Synthetic subject 1", emailsCount: 2 })
  })

  it("finds All Mail by its role when Gmail names it in another language", async () => {
    const { env } = setup([mail(1)], { allMail: "[Gmail]/Todos" })

    expect(await importInto(env)).toMatchObject({ listed: 1, saved: 1 })
    expect((await emails(env))[0]?.mailboxes.map(({ externalId }) => externalId)).toEqual(["[Gmail]/Todos"])
  })

  it("reads again by Gmail id only the emails whose attachment a missing reader left unread", async () => {
    const pdf = { name: "plan.pdf", mime: "application/pdf", content: "%PDF-1.4 synthetic" }
    const asked: string[] = []
    const { env } = setup(
      [mail(1, { attachment: pdf }), mail(2), mail(3, { attachment: { ...pdf, name: "notes.pdf" } })],
      {
        asked,
      },
    )
    const missing = async (name: string) => {
      throw Object.assign(new Error(`Cannot find package '${name}'`), { code: "ERR_MODULE_NOT_FOUND" })
    }
    const unpdf = {
      getDocumentProxy: async () => ({ numPages: 1, loadingTask: { destroy: async () => {} } }),
      extractText: async () => ({ text: ["Synthetic budget plan"], totalPages: 1 }),
    }
    const installed = async (name: string) => (name === "unpdf" ? unpdf : missing(name))
    const s = await store(env)
    const run = (loadEngine: (name: string) => Promise<unknown>, retryAttachments: boolean, max?: number) =>
      importMail({
        store: s,
        source: sourceOf(env),
        account: { address: ME },
        since: SINCE,
        now: () => NOW,
        loadEngine,
        retryAttachments,
        ...(max === undefined ? {} : { max }),
      })
    await run(missing, false)
    const failures = async () =>
      (await s.mail.emails({})).flatMap(({ attachments }) => attachments.map(({ extractionError }) => extractionError))
    expect((await failures()).sort()).toEqual(["engine-missing", "engine-missing"])

    asked.length = 0
    const first = await run(installed, true, 1)
    expect(first.retried).toEqual({ emails: 1, extracted: 1, stillFailed: 0, missing: 0 })
    expect(first.complete).toBe(false)
    expect(asked.filter((line) => line.startsWith("msgid:"))).toHaveLength(1)
    expect(asked.filter((line) => !line.startsWith("msgid:"))).toEqual([expect.stringMatching(/^10[13]$/)])

    const second = await run(installed, true)
    expect(second.retried).toEqual({ emails: 1, extracted: 1, stillFailed: 0, missing: 0 })
    expect(await failures()).toEqual([null, null])
    const texts = (await s.mail.emails({})).flatMap(({ attachments }) => attachments.map(({ text }) => text))
    expect(texts).toEqual(["Synthetic budget plan", "Synthetic budget plan"])
    expect((await run(installed, true)).retried).toEqual({ emails: 0, extracted: 0, stillFailed: 0, missing: 0 })
  })

  it("indexes after saving the mail, and reports what the index step answered", async () => {
    const { env } = setup([mail(1)])
    const indexed: number[] = []
    const s = await store(env)
    const result = await importMail({
      store: s,
      source: sourceOf(env),
      account: { address: ME },
      since: SINCE,
      now: () => NOW,
      index: async (_store, key) => {
        indexed.push((await s.mail.emails({ accountId: (await s.accounts.storedAccount(key)).id })).length)
        return { chats: 0, chunks: 2, left: false }
      },
    })

    expect(indexed).toEqual([1])
    expect(result.indexed).toEqual({ chats: 0, chunks: 2, left: false })
  })

  it("reads Gmail labels and flags into label mailboxes, replaces them each run, and deletes labelled mail", async () => {
    const labelled = mail(1, {
      labels: ["Inbox", "Important", "Muy Importante", "Привет"],
      seen: true,
      flagged: true,
    })
    const { env, write } = setup([labelled, mail(2), mail(3), mail(4), mail(5), mail(6)])
    await importInto(env)
    const boxes = async () =>
      (await emails(env))
        .find(({ externalId }) => externalId === "9001")
        ?.mailboxes.filter(({ kind }) => kind === "label")
        .map(({ name }) => name)
        .sort()
    expect(await boxes()).toEqual(["Important", "Inbox", "Muy Importante", "Starred", "Привет"])
    expect((await emails(env)).find(({ externalId }) => externalId === "9001")).toMatchObject({
      read: true,
      flagged: true,
    })

    write([
      { ...labelled, labels: ["Inbox"], seen: false, flagged: false },
      mail(2),
      mail(3),
      mail(4),
      mail(5),
      mail(6),
    ])
    await importInto(env)
    expect(await boxes()).toEqual(["Inbox"])

    write([mail(2), mail(3), mail(4), mail(5), mail(6)])
    expect((await importInto(env)).deleted).toBe(1)
  })

  it("keeps read and starred current on mail already stored", async () => {
    const first = mail(1, { labels: ["Inbox"] })
    const { env, write } = setup([first])
    await importInto(env)
    expect((await emails(env))[0]).toMatchObject({ read: false, flagged: false })

    write([{ ...first, seen: true, flagged: true }])
    expect(await importInto(env)).toMatchObject({ saved: 0, alreadyStored: 1 })
    expect((await emails(env))[0]).toMatchObject({ read: true, flagged: true })
  })

  it("keeps a body up to the configured length", async () => {
    const { env } = setup([mail(1, { text: "x".repeat(50) })])
    await importMail({
      store: await store(env),
      source: sourceOf(env),
      account: { address: ME },
      since: SINCE,
      now: () => NOW,
      maxBodyChars: 10,
    })
    expect((await emails(env))[0]?.bodyText).toBe("x".repeat(10))
  })

  it("adds nothing when run again", async () => {
    const { env } = setup([mail(1), mail(2)])
    await importInto(env)

    expect(await importInto(env)).toMatchObject({ saved: 0, alreadyStored: 2, deleted: 0 })
  })

  it("saves the rest when one mail cannot be read, and reads that one next run", async () => {
    const { env, write } = setup([mail(1), mail(2), mail(3)], { unreadable: ["102"] })

    const first = await importInto(env)

    expect(first).toMatchObject({ saved: 2, complete: false, unreadable: [{ message: "9002" }] })
    write([mail(1), mail(2), mail(3)], { unreadable: [] })
    expect(await importInto(env)).toMatchObject({ saved: 1, alreadyStored: 2, complete: true })
  })

  it("keeps Cc addresses out of To", async () => {
    const { env } = setup([mail(1, { cc: [["Bob Sample", "bob@example.test"]] })])
    await importInto(env)

    const roles = (await emails(env))[0]?.recipients.map(({ address, role }) => `${role}:${address}`)
    expect(roles).toEqual([`to:${ME}`, "cc:bob@example.test"])
  })

  it("drops the text of a mail deleted at the source", async () => {
    const { env, write } = setup([mail(1), mail(2), mail(3), mail(4), mail(5), mail(6)])
    await importInto(env)
    write([mail(1), mail(2), mail(3), mail(4), mail(5)])

    expect(await importInto(env)).toMatchObject({ deleted: 1 })
    expect((await emails(env)).map(({ externalId }) => externalId)).not.toContain("9006")
  })

  it("saves a mail marked deleted again when the source lists it again", async () => {
    const all = [1, 2, 3, 4, 5, 6].map((n) => mail(n))
    const { env, write } = setup(all)
    await importInto(env)
    write(all.slice(0, 5))
    await importInto(env)
    write(all)

    expect(await importInto(env)).toMatchObject({ saved: 1, alreadyStored: 5, deleted: 0 })
    expect((await emails(env)).find(({ externalId }) => externalId === "9006")?.bodyText).toContain("Synthetic body 6")
  })

  it("leaves a stored mail at the window's edge alone", async () => {
    const edge = mail(1, { receivedAt: "2026-09-02T08:00:00Z" })
    const { env, write } = setup([edge, mail(2)])
    await importInto(env)
    write([mail(2)])

    expect(await importInto(env)).toMatchObject({ deleted: 0 })
  })

  it("deletes nothing when a large share is missing at the source", async () => {
    const all = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => mail(n))
    const { env, write } = setup(all)
    await importInto(env)
    write(all.slice(0, 2))

    const result = await importInto(env)

    expect(result.deleted).toBe(0)
    expect(result.deletionsSkipped).toContain("6 of 8")
  })

  it("deletes nothing and fails when the listing does not complete", async () => {
    const { env, write } = setup([mail(1), mail(2)])
    await importInto(env)
    write([], { searchFails: "IMAP command b did not complete: NO failed" })

    await expect(importInto(env)).rejects.toThrow("did not complete")
    expect(await emails(env)).toHaveLength(2)
  })

  it("reads at most max new mails, newest first, and continues on the next run", async () => {
    const { env } = setup([mail(1), mail(2), mail(3)])

    expect(await importInto(env, 2)).toMatchObject({ saved: 2, complete: false })
    expect(await importInto(env, 2)).toMatchObject({ saved: 1, alreadyStored: 2, complete: true })
  })

  it("keeps plain line ends", async () => {
    const { env } = setup([mail(1, { text: "line one\r\nline two" })])
    await importInto(env)

    expect((await emails(env))[0]?.bodyText).toBe("line one\nline two")
  })

  it("turns an HTML-only mail into text", async () => {
    const { env } = setup([
      mail(1, { text: undefined, html: "<style>p{}</style><p>Hello&nbsp;there</p><p>A &amp; B</p>" }),
    ])
    await importInto(env)

    expect((await emails(env))[0]?.bodyText).toBe("Hello there\nA & B")
  })
})

describe("syncMail with the owner's rules", () => {
  const rules = [
    { match: { domain: "shop.example" }, action: "skip" as const, decided_at: "2026-10-14T00:00:00.000Z" },
    { match: { from: "orders@shop.example" }, action: "keep" as const, decided_at: "2026-10-14T00:00:00.000Z" },
  ]

  it("never reads or stores a new email a skip rule matches, and keeps what was stored before", async () => {
    const news = mail(2, { from: ["Shop", "news@shop.example"], listId: "news.shop.example" })
    const { env, write } = setup([mail(1), mail(3, { from: [null, "orders@shop.example"] })])
    await importInto(env)
    write([
      mail(1),
      news,
      mail(3, { from: [null, "orders@shop.example"] }),
      mail(4, { from: [null, "sale@shop.example"] }),
    ])

    const result = await importMail({
      store: await store(env),
      source: sourceOf(env),
      account: { address: ME, rules },
      since: SINCE,
      now: () => NOW,
    })

    expect(result).toMatchObject({ listed: 4, saved: 0, alreadyStored: 2, skipped: 2, deleted: 0, complete: true })
    expect((await emails(env)).map(({ externalId }) => externalId).sort()).toEqual(["9001", "9003"])
  })

  const importRuled = async (env: NodeJS.ProcessEnv, ruled: MailRule[]) =>
    importMail({
      store: await store(env),
      source: sourceOf(env),
      account: { address: ME, rules: ruled },
      since: SINCE,
      now: () => NOW,
    })
  const envelope = (match: MailRule["match"]): MailRule => ({
    match,
    action: "envelope",
    decided_at: "2026-10-14T00:00:00.000Z",
  })

  it("records an email an envelope rule matches without its text, out of search, under the rule's mailbox", async () => {
    const deal = mail(2, {
      from: ["Shop Deals", "deals@shop.example"],
      subject: "Unrepeatable bargain",
      text: "Unrepeatable bargain inside",
      listId: "deals.shop.example",
    })
    const { env } = setup([mail(1), deal])

    const result = await importRuled(env, [...rules, envelope({ list_id: "deals.shop.example" })])

    expect(result).toMatchObject({ listed: 2, saved: 1, skipped: 0, envelopes: 1, complete: true })
    expect((await emails(env)).find(({ externalId }) => externalId === "9001")?.size).toBeGreaterThan(0)
    const recorded = (await emails(env)).find(({ externalId }) => externalId === "9002")
    expect(recorded).toMatchObject({
      subject: null,
      bodyText: null,
      fromAddress: "deals@shop.example",
      fromName: "Shop Deals",
      metadata: {
        rule: { action: "envelope", match: { list_id: "deals.shop.example" } },
        subject: "Unrepeatable bargain",
        listId: "deals.shop.example",
      },
    })
    expect(recorded?.size).toBeGreaterThan(0)
    const opening = await store(env)
    expect(await opening.mail.search("Unrepeatable")).toEqual([])
    expect(
      await opening.mail.emailRefs({
        accountId: (await opening.accounts.storedAccount(KEY)).id,
        mailbox: "memo:envelope:list-id:deals.shop.example",
      }),
    ).toHaveLength(1)
    expect((await importRuled(env, [envelope({ list_id: "deals.shop.example" })])).envelopes).toBe(0)
  })

  it("reads an envelope email in full once its rule is removed, and leaves the rule's mailbox", async () => {
    const deal = mail(2, { from: [null, "deals@shop.example"], subject: "Second look", text: "Now wanted" })
    const { env } = setup([deal])
    await importRuled(env, [envelope({ domain: "shop.example" })])

    const result = await importRuled(env, [])

    expect(result).toMatchObject({ saved: 1, envelopes: 0, complete: true })
    const [read] = await emails(env)
    expect(read).toMatchObject({ subject: "Second look", bodyText: "Now wanted", metadata: {} })
    expect(read?.mailboxes.map(({ kind }) => kind)).not.toContain("envelope")
    expect(await (await store(env)).mail.search("wanted")).toHaveLength(1)
  })

  it("fails the listing instead of importing mail unruled when Gmail refuses the header fetch", async () => {
    const { env } = setup([mail(1, { from: [null, "news@shop.example"] })], { headersFail: true })

    await expect(
      importMail({
        store: await store(env),
        source: sourceOf(env),
        account: { address: ME, rules },
        since: SINCE,
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "provider_error", details: { reason: "mail.source-failed" } })
    expect(await emails(env)).toEqual([])
  })

  const old = (id: string, from: FakeMail["from"] = [null, "rin@example.test"]): FakeMail => ({
    uid: "",
    messageId: id,
    threadId: id,
    receivedAt: "2023-07-24T10:00:00Z",
    subject: "Old",
    from,
    to: [[null, ME]],
    text: "Old body",
  })
  const archive = (...mails: FakeMail[]) => ({ mails, stamp: { size: 1, mtimeMs: 1 } })
  const fromArchive = async (env: NodeJS.ProcessEnv, held: ReturnType<typeof archive>, rules?: MailRule[]) =>
    importMail({
      store: await store(env),
      source: fakeArchiveSource(held),
      account: { address: ME, mode: "mbox", ...(rules ? { rules } : {}) },
      since: new Date(0),
      now: () => NOW,
    })

  it("adds an archive's mail to the IMAP account by Gmail id, skips by rule and deletes nothing", async () => {
    const { env } = setup([mail(1)])
    await importInto(env)

    const result = await fromArchive(
      env,
      archive(old("8001", ["Alice Example", "alice@example.test"]), old("8002", [null, "news@shop.example"])),
      rules,
    )

    expect(result).toMatchObject({ listed: 2, saved: 1, skipped: 1, deleted: 0 })
    expect(result.deletionsSkipped).toContain("snapshot")
    expect((await emails(env)).map(({ externalId }) => externalId).sort()).toEqual(["8001", "9001"])
  })

  it("leaves a mail IMAP proved deleted deleted when an archive still holds it", async () => {
    const all = [1, 2, 3, 4, 5, 6].map((n) => mail(n))
    const { env, write } = setup(all)
    await importInto(env)
    write(all.slice(0, 5))
    await importInto(env)

    const result = await fromArchive(env, archive(old("9006")))

    expect(result).toMatchObject({ listed: 1, saved: 0, alreadyStored: 1 })
    expect((await emails(env)).map(({ externalId }) => externalId)).not.toContain("9006")
  })

  it("does not read an unchanged archive again once it was read to the end", async () => {
    const { env } = setup([])
    const held = archive(old("8001"))

    expect(await fromArchive(env, held)).toMatchObject({ listed: 1, saved: 1 })
    expect(await fromArchive(env, held)).toMatchObject({ listed: 0, saved: 0 })
    held.mails.push(old("8002"))
    held.stamp = { size: 2, mtimeMs: 2 }
    expect(await fromArchive(env, held)).toMatchObject({ listed: 2, saved: 1, alreadyStored: 1 })
  })
})

describe("syncMail resuming", () => {
  const resumable = async (
    env: NodeJS.ProcessEnv,
    options: { max?: number; rescan?: boolean; at?: number; rules?: MailRule[] } = {},
  ) =>
    importMail({
      store: await store(env),
      source: sourceOf(env),
      account: { address: ME, ...(options.rules ? { rules: options.rules } : {}) },
      since: SINCE,
      now: () => options.at ?? NOW,
      resumeFrom: 0,
      ...(options.max === undefined ? {} : { max: options.max }),
      ...(options.rescan === undefined ? {} : { rescan: options.rescan }),
    })
  const listedUids = (asked: string[]) =>
    asked
      .splice(0)
      .flatMap((line) => line.split(","))
      .sort()
  const withLog = (messages: FakeMail[], extra: Omit<FakeMailbox, "messages"> = {}) => {
    const asked: string[] = []
    return { ...setup(messages, { asked, ...extra }), log: asked }
  }

  it("lists only mail no earlier run finished, so a run cut short by max goes on without listing again", async () => {
    const { env, log } = withLog([mail(1), mail(2), mail(3), mail(4)])

    expect(await resumable(env, { max: 2 })).toMatchObject({ pass: "full", saved: 2, complete: false })
    expect(listedUids(log)).toEqual(["101", "102", "103", "104"])
    expect(await resumable(env, { max: 2 })).toMatchObject({ pass: "resumed", listed: 2, saved: 2, complete: true })
    expect(listedUids(log)).toEqual(["101", "102"])
    expect(await resumable(env)).toMatchObject({ pass: "resumed", listed: 0, saved: 0 })
    expect(listedUids(log)).toEqual([])
  })

  it("leaves deletions to a whole listing: with --rescan, after a day, or once the rules change", async () => {
    const all = [1, 2, 3, 4, 5, 6].map((n) => mail(n))
    const { env, write, log } = withLog(all)
    await resumable(env)
    write(all.slice(0, 5))

    const resumed = await resumable(env)
    expect(resumed).toMatchObject({ pass: "resumed", deleted: 0 })
    expect(resumed.deletionsSkipped).toContain("--rescan")
    expect(await resumable(env, { rescan: true })).toMatchObject({ pass: "full", deleted: 1 })
    listedUids(log)
    expect(await resumable(env, { at: NOW + 86_400_000 })).toMatchObject({ pass: "full", listed: 5 })
    const rules: MailRule[] = [{ match: { domain: "shop.example" }, action: "envelope", decided_at: "2026-10-01" }]
    expect(await resumable(env, { rules })).toMatchObject({ pass: "full", listed: 5 })
    expect(await resumable(env, { rules })).toMatchObject({ pass: "resumed", listed: 0 })
  })

  it("lists everything again when the mailbox's UIDVALIDITY changes", async () => {
    const { env, write } = withLog([mail(1), mail(2)])
    await resumable(env)
    write([mail(1), mail(2)], { validity: 13 })

    expect(await resumable(env)).toMatchObject({ pass: "full", listed: 2, alreadyStored: 2 })
  })

  it("keeps the widest window ever listed, not a later narrow run that started the resume point over", async () => {
    const { env } = withLog([1, 2, 3, 4, 5, 6].map((n) => mail(n)))
    await resumable(env, { max: 2 })
    const rules: MailRule[] = [{ match: { domain: "shop.example" }, action: "envelope", decided_at: "2026-10-01" }]
    await importMail({
      store: await store(env),
      source: sourceOf(env),
      account: { address: ME, rules },
      since: new Date("2026-09-15T00:00:00Z"),
      now: () => NOW,
      resumeFrom: 0,
    })

    const kept = (await (await store(env)).sync.syncState(KEY, resumeKey("[Gmail]/All Mail")))?.value
    const point = JSON.parse(kept as string) as ResumePoint
    expect(point.widest).toMatchObject({ since: SINCE.toISOString(), total: 6 })
    expect(point.last).toMatchObject({ since: "2026-09-15T00:00:00.000Z", done: 2, total: 2 })
  })

  it("keeps List-Id and the bulk fields on mail stored in full", async () => {
    const { env } = setup([mail(1, { listId: "news.shop.example" }), mail(2)])
    await importInto(env)

    const byId = new Map((await emails(env)).map((email) => [email.externalId, email.headers]))
    expect(byId.get("9001")).toEqual({ "list-id": "news.shop.example", "list-unsubscribe": true })
    expect(byId.get("9002")).toBeNull()
  })
})

describe("syncMail attachments", () => {
  it("keeps attachment text on its email, an own note on it, and drops the text when the mail disappears", async () => {
    const csv = { name: "budget.csv", mime: "text/csv", content: "name,value\r\nSynthetic,123\r\n" }
    const { env, write } = setup([mail(1, { attachment: csv })])
    const s = await store(env)
    const first = await importInto(env)
    expect(first.attachments).toEqual([{ message: "9001", part: 0, status: "extracted" }])
    const note = await s.knowledge.addAnnotation(
      KEY,
      { type: "message", locator: formatLocator({ ...KEY, chat: "9001", message: "9001" }) },
      "Own analysis",
    )
    expect((await importInto(env)).deleted).toBe(0)
    const { id } = await s.accounts.storedAccount(KEY)
    expect((await s.mail.email(id, "9001"))?.attachments[0]).toMatchObject({
      name: "budget.csv",
      providerRef: { message: "9001", part: 0 },
    })
    expect((await s.mail.email(id, "9001"))?.attachments[0]?.text).toContain("name: Synthetic; value: 123")

    write([])
    expect((await importInto(env)).deleted).toBe(1)
    expect((await s.mail.email(id, "9001"))?.attachments[0]?.text).toBeNull()
    expect(await s.knowledge.annotation(KEY, note.id)).toMatchObject({ targetState: "deleted", text: "Own analysis" })
  })
})

describe("syncMail coverage", () => {
  it("writes the window it read, unless the run is a spot read", async () => {
    const { env } = setup([mail(1)])
    await importInto(env)
    const opening = await store(env)
    const coverage = async () => (await opening.sync.syncState(KEY, "mail_coverage"))?.value
    const full = await coverage()
    expect(full).toContain(SINCE.toISOString())

    const spot = new Date(NOW - 10 * 60 * 1000)
    await importMail({
      store: opening,
      source: sourceOf(env),
      account: { address: ME },
      since: spot,
      now: () => NOW,
      saveCoverage: false,
    })
    expect(await coverage()).toBe(full)
  })
})

describe("syncMail with a request budget", () => {
  const twelve = Array.from({ length: 12 }, (_, i) => mail(i + 1))
  const budgeted = async (env: NodeJS.ProcessEnv, requests: number | undefined, extra: Partial<MailSyncOptions> = {}) =>
    syncMail(sourceOf(env), await store(env), {
      account: { address: ME },
      since: SINCE,
      now: () => NOW,
      budget: runBudget(requests === undefined ? {} : { requests }),
      ...extra,
    })

  it("reads the window in slices, one request per call, and answers complete", async () => {
    const calls = { search: 0, list: 0, fetchRaw: 0 }
    const { env } = setup(twelve, { calls, listBatch: 5, fetchBatch: 5 })

    const result = await budgeted(env, undefined)

    expect(result).toMatchObject({ listed: 12, saved: 12, complete: true, state: "complete", remaining: 0 })
    expect(calls).toEqual({ search: 1, list: 3, fetchRaw: 3 })
    expect(result.requests).toBe(7)
  })

  it("stops when the budget is spent, keeps what it read, and the next run goes on from there", async () => {
    const asked: string[] = []
    const { env } = setup(twelve, { asked, listBatch: 5, fetchBatch: 5 })

    const first = await budgeted(env, 3)
    expect(first).toMatchObject({ saved: 5, complete: false, state: "partial", stopped: "requests", remaining: 7 })
    expect(await emails(env)).toHaveLength(5)

    asked.length = 0
    const second = await budgeted(env, 3)
    expect(second).toMatchObject({ saved: 5, state: "partial", pass: "resumed" })
    expect(asked.join(",").split(",")).not.toContain("101")

    const third = await budgeted(env, undefined)
    expect(third).toMatchObject({ saved: 2, complete: true, state: "complete" })
    expect(await emails(env)).toHaveLength(12)
  })

  it("asks again once for a message the server failed on, and counts what still fails", async () => {
    const { env } = setup(twelve, { failOnce: ["103", "104"], unreadable: ["105"], listBatch: 6, fetchBatch: 6 })

    const result = await budgeted(env, undefined)

    expect(result.saved).toBe(11)
    expect(result).toMatchObject({ complete: false, state: "partial" })
    expect(result.unreadable).toEqual([{ message: "9005", reason: "email 105 was not read" }])
    const point = JSON.parse(
      (await (await store(env)).sync.syncState(KEY, resumeKey("[Gmail]/All Mail")))?.value ?? "{}",
    )
    expect(point.done).not.toContainEqual([105, 105])
  })

  it("ends a run whose request failed after the budget was spent as partial, keeping the earlier rounds", async () => {
    const { env } = setup(twelve, { listBatch: 5, fetchBatch: 5 })
    const inner = sourceOf(env)
    let lists = 0
    const source: MailSource = {
      ...inner,
      list: async (...args) => {
        if (++lists === 2) throw new CliError("timeout", "the mail server did not answer in time")
        return inner.list(...args)
      },
    }

    const result = await syncMail(source, await store(env), {
      account: { address: ME },
      since: SINCE,
      now: () => NOW,
      budget: runBudget({ requests: 4 }),
    })

    expect(result).toMatchObject({ saved: 5, state: "partial", stopped: "requests" })
    expect(await emails(env)).toHaveLength(5)
    const roomLeft = syncMail(source, await store(env), {
      account: { address: ME },
      since: SINCE,
      now: () => NOW,
      budget: runBudget({ requests: 100 }),
    })
    await expect(roomLeft).resolves.toMatchObject({ saved: 7, complete: true })
  })

  const lockedOnSave = (real: MessageStore, failing: number) => {
    let saves = 0
    return {
      ...real,
      mail: {
        ...real.mail,
        saveThreads: async (...args: Parameters<MessageStore["mail"]["saveThreads"]>) => {
          if (++saves === failing)
            throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 })
          return real.mail.saveThreads(...args)
        },
      },
    } as MessageStore
  }

  it.each([
    ["listed by headers", false],
    ["listed quickly", true],
  ])("waits out a store another process has locked and reads the round again (%s)", async (_, quick) => {
    const { env } = setup(twelve, { listBatch: 5, fetchBatch: 5, quick })
    const waits: number[] = []

    const result = await syncMail(sourceOf(env), lockedOnSave(await store(env), 3), {
      account: { address: ME },
      since: SINCE,
      now: () => NOW,
      budget: runBudget({}),
      wait: async (ms) => void waits.push(ms),
    })

    expect(result).toMatchObject({ complete: true, state: "complete" })
    expect(waits).toEqual([2000])
    expect(await emails(env)).toHaveLength(12)
  })

  it("ends as partial when the store stays locked and the budget has no room to wait", async () => {
    const { env } = setup(twelve, { listBatch: 5, fetchBatch: 5 })

    const result = await syncMail(sourceOf(env), lockedOnSave(await store(env), 2), {
      account: { address: ME },
      since: SINCE,
      now: () => NOW,
      budget: runBudget({ requests: 5 }),
      wait: async () => {},
    })

    expect(result).toMatchObject({ state: "partial", stopped: "requests" })
    expect(await emails(env)).toHaveLength(5)
  })

  it("does not let a failed message hide behind the resume point", async () => {
    const { env, box } = setup(twelve, { unreadable: ["105"], listBatch: 20, fetchBatch: 20 })
    await budgeted(env, undefined)
    delete box.unreadable

    const again = await budgeted(env, undefined)

    expect(again).toMatchObject({ saved: 1, complete: true })
  })
})
