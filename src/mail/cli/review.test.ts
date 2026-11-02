import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { type ProgramDefinition, run } from "../../cli/program.js"
import { settingsFor } from "../../cli/settings.js"
import type { EmailInput, MailboxInput } from "../../store/index.js"
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
const HOUR = 3_600_000
const BULK: MailboxInput = { externalId: "memo:bulk", name: "bulk", kind: "bulk" }
const ENVELOPE: MailboxInput = { externalId: "memo:envelope:from:x", name: "envelope: from x", kind: "envelope" }

const ann = { address: "ann@example.com", name: "Ann" }
const me = { address: MINE.account, name: "Me" }

const email = (id: string, hoursAgo: number, fields: Partial<EmailInput> = {}): EmailInput => {
  const at = Date.now() - hoursAgo * HOUR
  return {
    externalId: `<${id}@example.com>`,
    subject: id,
    from: ann,
    to: [me],
    sentAt: at,
    receivedAt: at,
    bodyText: `text of ${id}`,
    ...fields,
  }
}

const mailbox = async () => {
  const root = mkdtempSync(join(tmpdir(), "mail-review-"))
  const env = { MAIL_CONFIG_DIR: join(root, "config"), MAIL_STATE_DIR: join(root, "state") }
  mkdirSync(env.MAIL_CONFIG_DIR, { recursive: true })
  writeFileSync(join(env.MAIL_CONFIG_DIR, "config.json"), JSON.stringify({ profiles: { ya: {} } }))
  const path = join(root, "store.db")
  const opened = await openStore({ path })
  const accountId = await opened.accounts.saveAccount(MINE, { name: null })
  await opened.close()
  const withStore = async <T>(work: (store: Awaited<ReturnType<typeof openStore>>) => Promise<T>) => {
    const store = await openStore({ path })
    try {
      return await work(store)
    } finally {
      await store.close()
    }
  }
  const synced = (until = Date.now()) =>
    withStore((store) =>
      store.sync.setSyncState(
        MINE,
        "mail_coverage",
        JSON.stringify({ since: new Date(0).toISOString(), until: new Date(until).toISOString(), state: "window" }),
      ),
    )
  const thread = (id: string, ...emails: EmailInput[]) =>
    withStore((store) => store.mail.saveThread({ accountId, externalId: id, now: Date.now(), emails }))
  const definition: ProgramDefinition = {
    app,
    configuration: settingsFor(app),
    commands: () => mailReadCommands({ app, read: (_command, work) => withStore((store) => work(store, MINE)) }),
  }
  const json = async (argv: string[], extra: Record<string, string> = {}) => {
    const streams = captureStreams()
    const code = await run(["ya", "review", ...argv, "--json"], definition, {
      streams,
      tty: false,
      env: { ...env, ...extra },
    })
    expect(code, streams.stderr.join("")).toBe(0)
    return JSON.parse(streams.stdout.join("")) as {
      items: {
        ref: string
        chat_id: string
        chat_title: string
        text: string
        sender_is_me: boolean
        email: Record<string, unknown>
      }[]
      missing?: { why: string; step?: string }[]
      next?: { command: string }[]
      meta?: { complete?: boolean }
    }
  }
  const refused = async (argv: string[]) => {
    const streams = captureStreams()
    return run(["ya", "review", ...argv, "--json"], definition, { streams, tty: false, env })
  }
  return { env, accountId, withStore, synced, thread, json, refused }
}

const texts = (answer: { items: { text: string }[] }) => answer.items.map((one) => one.text.split("\n").at(-1))

const threads = (answer: { items: { chat_id: string }[] }) => [...new Set(answer.items.map((one) => one.chat_id))]

describe("mail review", () => {
  it("shows every email, both sides, of threads that changed, in messenger review's item shape", async () => {
    const box = await mailbox()
    await box.thread("t-bill", email("bill", 30), email("paid", 2, { from: me, to: [ann], outgoing: true }))
    await box.thread("t-old", email("old", 24 * 5))
    await box.synced()

    const answer = await box.json(["date>1d"])

    expect(texts(answer)).toEqual(["text of paid"])
    expect(answer.items[0]).toMatchObject({
      ref: "msg:email/me%40example.com/t-bill/%3Cpaid%40example.com%3E",
      chat_id: "t-bill",
      chat_title: "bill",
      sender_is_me: true,
      outgoing: true,
    })
    expect(Object.keys(answer.items[0] ?? {}).sort()).toEqual([
      "attachments",
      "chat_id",
      "chat_title",
      "email",
      "outgoing",
      "ref",
      "sender_is_me",
      "sender_name",
      "text",
      "timestamp",
    ])
    expect(threads(await box.json([]))).toEqual(["t-bill"])
  })

  it("--new shows each email once, and mail stored later in the next run", async () => {
    const box = await mailbox()
    await box.thread("t-1", email("first", 3))
    await box.synced(Date.now() - 2 * HOUR)

    expect(threads(await box.json(["--new"]))).toEqual(["t-1"])
    expect((await box.json(["--new"])).items).toEqual([])
    const point = JSON.parse(readFileSync(join(box.env.MAIL_STATE_DIR, "review", "me%40example.com.json"), "utf8"))
    expect(point).toEqual({ lastCheckAt: expect.any(String), chats: {} })

    await box.thread("t-1", email("reply", 1))
    await box.thread("t-2", email("second", 1))
    await box.synced()
    expect(texts(await box.json(["--new"])).sort()).toEqual(["text of reply", "text of second"])
  })

  it("leaves mail newer than the last finished sync for the next review", async () => {
    const box = await mailbox()
    await box.thread("t-1", email("early", 3), email("late", 1))
    await box.synced(Date.now() - 2 * HOUR)

    const first = await box.json(["--new"])
    expect(texts(first)).toEqual(["text of early"])

    await box.synced()
    expect(texts(await box.json(["--new"]))).toEqual(["text of late"])
  })

  it("keeps a point per reader: a scheduled run and the owner do not move each other's", async () => {
    const box = await mailbox()
    await box.thread("t-1", email("first", 3))
    await box.synced()

    expect(threads(await box.json(["--new"], { MAIL_SCHEDULED: "triage" }))).toEqual(["t-1"])
    expect(threads(await box.json(["--new"]))).toEqual(["t-1"])
    expect(threads(await box.json(["--new"], { MAIL_SCHEDULED: "digest" }))).toEqual(["t-1"])
    expect((await box.json(["--new"], { MAIL_SCHEDULED: "triage" })).items).toEqual([])
    expect(readdirSync(join(box.env.MAIL_STATE_DIR)).sort()).toEqual([
      "review",
      "schedule-digest-review",
      "schedule-triage-review",
    ])
  })

  it("shows all mail, each email marked bulk, list and rule; bulk:false leaves out mail sent to many", async () => {
    const box = await mailbox()
    await box.thread("t-bulk", email("bulk", 2, { mailboxes: [BULK] }))
    await box.thread("t-list", email("list", 2, { headers: { "list-id": "news.example.com" } }))
    await box.thread("t-envelope", email("envelope", 2, { mailboxes: [ENVELOPE], bodyText: null }))
    await box.thread("t-scam", email("scam", 2, { from: { address: "scam@example.net", name: null } }))
    await box.thread("t-ann", email("ann", 2))
    await box.withStore((store) =>
      store.mail.setSenderScores(
        box.accountId,
        [{ address: "scam@example.net", score: 9, signals: ["brand_spoof"], demoted: true }],
        Date.now(),
      ),
    )
    await box.synced()

    const all = await box.json([])
    expect(threads(all).sort()).toEqual(["t-ann", "t-bulk", "t-envelope", "t-list", "t-scam"])
    const marks = Object.fromEntries(all.items.map((one) => [one.chat_id, one.email]))
    expect(marks["t-bulk"]).toMatchObject({ bulk: true, list_id: null, rule_id: null })
    expect(marks["t-list"]).toMatchObject({ bulk: false, list_id: "news.example.com" })
    expect(marks["t-ann"]).toMatchObject({ bulk: false, list_id: null, rule_id: null })
    expect(marks["t-scam"]).toMatchObject({ sender_score: { demoted: true } })

    const personal = await box.json(["bulk:false"])
    expect(threads(personal).sort()).toEqual(["t-ann", "t-scam"])
    expect(personal.missing).toContainEqual(expect.objectContaining({ why: expect.stringContaining("bulk:false") }))
    expect(await box.refused(["bulk:true"])).toBe(2)
  })

  it("--unanswered: the newest email came to you in To or Cc, with no answer; your reply takes a thread off", async () => {
    const box = await mailbox()
    await box.thread("t-owed", email("owed-1", 50), email("owed-2", 48))
    await box.thread("t-answered", email("asked", 50), email("answered", 40, { from: me, to: [ann], outgoing: true }))
    await box.thread("t-cc", email("cc", 50, { to: [{ address: "bob@example.com", name: null }], cc: [me] }))
    await box.thread("t-bcc", email("bcc", 50, { to: [{ address: "bob@example.com", name: null }] }))
    await box.thread("t-fresh", email("fresh", 2))
    await box.thread("t-bulk", email("bulk", 50, { mailboxes: [BULK] }))
    await box.synced()

    const owed = await box.json(["--unanswered", "1d"])
    expect(threads(owed).sort()).toEqual(["t-bulk", "t-cc", "t-owed"])
    expect(texts(owed).filter((text) => text?.startsWith("text of owed"))).toEqual(["text of owed-1", "text of owed-2"])
    expect(threads(await box.json(["bulk:false", "--unanswered", "1d"])).sort()).toEqual(["t-cc", "t-owed"])
  })

  it("--waiting: threads where you wrote last, older than the duration, only your unanswered emails", async () => {
    const box = await mailbox()
    await box.thread("t-wait", email("ask", 24 * 10), email("mine", 24 * 8, { from: me, to: [ann], outgoing: true }))
    await box.thread("t-recent", email("mine-recent", 24, { from: me, to: [ann], outgoing: true }))
    await box.synced()

    const waiting = await box.json(["--waiting"])
    expect(threads(waiting)).toEqual(["t-wait"])
    expect(texts(waiting)).toEqual(["text of mine"])
    expect(threads(await box.json(["--waiting", "12h"])).sort()).toEqual(["t-recent", "t-wait"])
  })

  it("refuses --new with a date, --unanswered or --waiting, and answers empty with nothing synced", async () => {
    const box = await mailbox()
    for (const argv of [
      ["--new", "date>1d"],
      ["--new", "--unanswered"],
      ["--new", "--waiting"],
    ])
      expect(await box.refused(argv)).toBe(2)
    const empty = await box.json([])
    expect(empty.items).toEqual([])
    expect(empty.meta?.complete).toBe(false)
    expect(existsSync(join(box.env.MAIL_STATE_DIR, "review"))).toBe(false)
  })
})
