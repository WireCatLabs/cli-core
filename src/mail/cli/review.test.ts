import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import { LOCAL_WRITE, proposesOnly } from "../../cli/effects.js"
import { type ProgramDefinition, run } from "../../cli/program.js"
import { settingsFor } from "../../cli/settings.js"
import { overrideSharedContract } from "../../cli/shared-contracts.js"
import type { EmailInput, MailboxInput } from "../../store/index.js"
import { type AccountKey, openStore } from "../../store/store.js"
import { advancePastSkipped, mailWaiting, marksOf, readPastMark } from "../marks.js"
import { BULK_TRIAGE_DEFAULTS } from "../newsletter.js"
import { type MailMount, mailReadCommands } from "./index.js"

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

/** memo's shape: review under `mail`, acknowledge under `messages`, and `--source` naming the mailbox. */
const MEMO_MOUNT: MailMount = {
  review: "mail review",
  acknowledge: "messages acknowledge",
  conversation: null,
  mailbox: { option: "source", value: (mailbox) => `email:${mailbox.account}` },
}

const mounted = (shared: Command[]): Command[] => {
  const review = shared.find((one) => one.name() === "review") as Command
  const messages = shared.find((one) => one.name() === "messages") as Command
  const acknowledge = messages.commands.find((one) => one.name() === "acknowledge") as Command
  for (const command of [review, acknowledge])
    overrideSharedContract(command, "the host names the mailbox with --source.", (one) => {
      one.option("--source <accounts>", "the one mailbox")
    })
  return [new Command("mail").addCommand(review), new Command("messages").addCommand(acknowledge)]
}

const mailbox = async (mount?: MailMount) => {
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
    commands: () => [
      ...(mount
        ? mounted(mailReadCommands({ app, read: (_command, work) => withStore((store) => work(store, MINE)), mount }))
        : mailReadCommands({ app, read: (_command, work) => withStore((store) => work(store, MINE)) })),
      // Two local writes outside the propose tier: one unmarked, one marked on a path the tier does not list.
      annotate(new Command("scribble"), { effects: LOCAL_WRITE }).action(() => {}),
      proposesOnly(annotate(new Command("sneak"), { effects: LOCAL_WRITE })).action(() => {}),
    ],
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
  const cli = async (argv: string[], extra: Record<string, string> = {}) => {
    const streams = captureStreams()
    const code = await run(["ya", ...argv, "--json"], definition, { streams, tty: false, env: { ...env, ...extra } })
    return { code, out: streams.stdout.join(""), err: streams.stderr.join("") }
  }
  return { env, accountId, withStore, synced, thread, json, refused, cli }
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
      "untrusted",
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

describe("a holder's processing mark", () => {
  const PARTIAL = { partial: { bytes: 100 } }
  const setUp = async () => {
    const box = await mailbox()
    const read = async (holder = "triage") => {
      const answer = await box.json(["--holder", holder])
      const next = (answer.next ?? []) as { step?: string; args?: { cursor?: string } }[]
      return { answer, cursor: next.find((one) => one.step === "mail-messages.acknowledge")?.args?.cursor as string }
    }
    const ack = async (cursor: string, holder = "triage") => {
      const done = await box.cli(["messages", "acknowledge", "--holder", holder, "--cursor", cursor])
      expect(done.code, done.err).toBe(0)
      return JSON.parse(done.out).item
    }
    return { ...box, read, ack }
  }

  it("starts from now, then reads by store order: mail stored late with an old date is still read", async () => {
    const box = await setUp()
    await box.thread("t-old", email("before", 5))
    await box.synced()
    const first = await box.read()
    expect(first.answer.items).toEqual([])
    expect(await box.ack(first.cursor)).toMatchObject({ holder: "triage", read: 0, held: 0 })

    await box.thread("t-late", email("late-old", 24 * 20))
    await box.thread("t-new", email("new", 1))
    await box.thread("t-bulk", email("bulk", 1, { mailboxes: [BULK], subject: "Weekly digest: autumn sale" }))
    await box.synced()
    const second = await box.read()
    expect(texts(second.answer).sort()).toEqual(["text of late-old", "text of new"])
    expect(second.answer.missing).toContainEqual(
      expect.objectContaining({ why: expect.stringContaining("1 newsletter") }),
    )

    const again = await box.read()
    expect(texts(again.answer).sort()).toEqual(["text of late-old", "text of new"])
    const mark = await box.ack(again.cursor)
    expect(mark).toMatchObject({ read: 2, skipped: { bulk: 1, envelope: 0, partial: 0, draft: 0 } })
    expect((await box.read()).answer.items).toEqual([])
    expect(await box.ack(again.cursor)).toMatchObject({ read: 2 })
  })

  it("gives bulk mail that is not surely a newsletter as an excerpt, after the rest; newsletters stay out", async () => {
    const box = await setUp()
    await box.synced()
    await box.ack((await box.read()).cursor)
    const lead = [
      "Имя: Иван",
      "Телефон: +7 900 000-00-00",
      "Номер заявки в админке: 4512",
      "Хочу посмотреть бизнес. ".repeat(40),
    ].join("\n")
    const site = { address: "info@burobiz.example", name: null }
    await box.thread(
      "t-lead",
      email("lead", 3, { mailboxes: [BULK], from: site, subject: "Форма: «Бизнес покажет»", bodyText: lead }),
    )
    await box.thread(
      "t-news",
      email("news", 2, {
        mailboxes: [BULK],
        from: { address: "news@shop.example", name: "Shop" },
        subject: "Новинки недели",
      }),
    )
    await box.thread("t-ann", email("ann", 1))
    await box.synced()
    const { answer } = await box.read()
    expect(threads(answer)).toEqual(["t-ann", "t-lead"])
    const shown = answer.items[1]
    expect(shown?.email).toMatchObject({ bulk: true, excerpt_only: true })
    expect(shown?.text.startsWith("Форма: «Бизнес покажет»\n\nИмя: Иван\nТелефон")).toBe(true)
    expect(shown?.text.length).toBeLessThan(BULK_TRIAGE_DEFAULTS.cues.excerptChars + 30)
    expect(answer.items[0]?.email.excerpt_only).toBeUndefined()
    const why = (answer.missing ?? []).map((one) => one.why)
    expect(why).toContainEqual(expect.stringContaining("left out: 1 newsletter"))
    expect(why).toContainEqual(expect.stringContaining("1 bulk emails (excerpt_only)"))
  })

  it("ends a read at its share of excerpts, so the next read gives the rest; without excerpts all bulk stays out", async () => {
    const box = await setUp()
    await box.synced()
    await box.ack((await box.read()).cursor)
    for (const [id, hours] of [
      ["one", 3],
      ["two", 2],
    ] as const)
      await box.thread(`t-${id}`, email(id, hours, { mailboxes: [BULK], subject: `Your order ${id}` }))
    await box.thread("t-ann", email("ann", 1))
    await box.synced()
    const read = (triage = BULK_TRIAGE_DEFAULTS) =>
      box.withStore((store) => readPastMark(store, MINE, "triage", { triage }))
    const first = await read({ ...BULK_TRIAGE_DEFAULTS, perRead: 1 })
    expect(first.excerpts.map(({ excerpt }) => excerpt)).toEqual(["text of one"])
    expect(first.emails).toEqual([])
    expect(first.more).toBe(true)
    await box.ack(first.cursor)
    const rest = await read({ ...BULK_TRIAGE_DEFAULTS, perRead: 1 })
    expect(rest.excerpts.map(({ excerpt }) => excerpt)).toEqual(["text of two"])
    expect(rest.emails.map((one) => one.email?.subject)).toEqual(["ann"])
    const none = await read({ ...BULK_TRIAGE_DEFAULTS, excerpts: false })
    expect(none.excerpts).toEqual([])
    expect(none.skipped.bulk).toBe(1)
  })

  it("never moves back, and two holders keep their own marks", async () => {
    const box = await setUp()
    await box.synced()
    const start = await box.read()
    await box.ack(start.cursor)
    await box.ack((await box.read("digest")).cursor, "digest")
    await box.thread("t-1", email("one", 1))
    await box.synced()
    const one = await box.read()
    await box.ack(one.cursor)

    const back = await box.cli(["messages", "acknowledge", "--holder", "triage", "--cursor", start.cursor])
    expect(back.code).toBe(2)
    expect(texts((await box.read("digest")).answer)).toEqual(["text of one"])
    expect((await box.read()).answer.items).toEqual([])
  })

  it("holds a partial email until it is whole, then gives it once", async () => {
    const box = await setUp()
    await box.synced()
    await box.ack((await box.read()).cursor)
    await box.thread("t-big", email("big", 1, { metadata: PARTIAL }))
    await box.synced()
    const held = await box.read()
    expect(held.answer.items).toEqual([])
    expect(await box.ack(held.cursor)).toMatchObject({ held: 1, read: 0 })

    await box.thread("t-big", email("big", 1, { metadata: { partial: null } }))
    await box.synced()
    const whole = await box.read()
    expect(texts(whole.answer)).toEqual(["text of big"])
    expect(await box.ack(whole.cursor)).toMatchObject({ held: 0, read: 1 })
    expect((await box.read()).answer.items).toEqual([])
  })

  it("lists every holder's mark for status, and refuses a bad holder or cursor", async () => {
    const box = await setUp()
    await box.synced()
    await box.ack((await box.read()).cursor)
    await box.ack((await box.read("digest")).cursor, "digest")
    const marks = await box.withStore((store) => marksOf(store, MINE))
    expect(marks.map((one) => one.holder)).toEqual(["digest", "triage"])
    expect((await box.cli(["messages", "acknowledge", "--holder", "Bad Name", "--cursor", "1.1"])).code).toBe(2)
    expect((await box.cli(["messages", "acknowledge", "--holder", "triage", "--cursor", "soon"])).code).toBe(2)
    const forged = await box.cli(["messages", "acknowledge", "--holder", "triage", "--cursor", "999999999.1"])
    expect(forged.code).toBe(2)
    expect(forged.err).toContain("mail.cursor-ahead")
    expect(await box.refused(["--holder", "triage", "--unanswered"])).toBe(2)
  })
})

describe("what the mail pipeline reads and may write under the read-only lock", () => {
  const read = async (box: Awaited<ReturnType<typeof mailbox>>, extra: Record<string, string> = {}) => {
    const answer = await box.json(["--holder", "triage"], extra)
    const next = (answer.next ?? []) as { step?: string; args?: { cursor?: string } }[]
    return { answer, cursor: next.find((one) => one.step === "mail-messages.acknowledge")?.args?.cursor as string }
  }

  it("leaves out suspicious senders and gives each email its own text, its fingerprint and whether its sender is new", async () => {
    const box = await mailbox()
    await box.thread("t-first", email("first", 3))
    await box.synced()
    const start = await read(box)
    expect((await box.cli(["messages", "acknowledge", "--holder", "triage", "--cursor", start.cursor])).code).toBe(0)
    await box.thread("t-again", email("again", 1))
    const reply =
      "Can we meet on Friday?\n-- \nBob Example\n\nOn Mon, 3 Nov 2026, Ann <ann@example.com> wrote:\n> earlier"
    await box.thread("t-new", email("hello", 1, { from: { address: "bob@example.org", name: "Bob" }, bodyText: reply }))
    await box.thread("t-scam", email("scam", 1, { from: { address: "scam@example.net", name: null } }))
    await box.withStore((store) =>
      store.mail.setSenderScores(
        box.accountId,
        [{ address: "scam@example.net", score: 9, signals: ["brand_spoof"], demoted: true }],
        Date.now(),
      ),
    )
    await box.synced()

    const { answer } = await read(box)

    expect(threads(answer).sort()).toEqual(["t-again", "t-new"])
    expect(answer.missing).toContainEqual(expect.objectContaining({ why: expect.stringContaining("1 suspicious") }))
    const byThread = Object.fromEntries(answer.items.map((one) => [one.chat_id, one]))
    expect(byThread["t-again"]?.email).toMatchObject({ new_sender: false, sender_identities: 1 })
    expect(byThread["t-new"]?.email).toMatchObject({ new_sender: true, sender_identities: 1 })
    const cited = byThread["t-new"] as (typeof answer.items)[number]
    expect(cited.text).toBe("hello\n\nCan we meet on Friday?")
    expect((cited as typeof cited & { untrusted: string[] }).untrusted).toEqual(
      expect.arrayContaining(["text", "sender_name", "email.subject", "email.from.name"]),
    )
    const staged = await box.withStore(async (store) => {
      await store.knowledge.addProject({ name: "Example" })
      return store.mailFindings.stage(
        MINE,
        {
          schemaVersion: 1,
          key: "triage:9",
          extractor: "test",
          findings: [
            {
              id: "c1",
              kind: "new_contact",
              address: "bob@example.org",
              name: "Bob Example",
              evidence: [{ reference: cited.ref, fingerprint: cited.email.fingerprint as string }],
            },
          ],
        },
        { bot: "triage" },
      )
    })
    expect(staged.status).toBe("proposed")
  })

  it("lets a read-only run move its mark, and refuses every other local write", async () => {
    const box = await mailbox()
    await box.synced()
    const lock = { MAIL_READ_ONLY: "1", MAIL_MAIL_HOLDER: "triage" }
    const { cursor } = await read(box, lock)

    expect((await box.cli(["messages", "acknowledge", "--holder", "triage", "--cursor", cursor], lock)).code).toBe(0)
    expect((await box.cli(["scribble"], lock)).code).toBe(5)
    expect((await box.cli(["sneak"], lock)).code).toBe(5)
    expect((await box.cli(["scribble"])).code).toBe(0)
  })

  it("lets a scheduled agent move only the holder its schedule names; the owner moves any", async () => {
    const box = await mailbox()
    await box.synced()
    const { cursor } = await read(box)
    const ack = (holder: string, extra: Record<string, string>) =>
      box.cli(["messages", "acknowledge", "--holder", holder, "--cursor", cursor], extra)
    const scheduled = { MAIL_READ_ONLY: "1", MAIL_MAIL_HOLDER: "triage" }

    const other = await ack("digest", scheduled)
    expect(other.code).toBe(5)
    expect(other.err).toContain("mail.holder-not-yours")
    expect((await ack("triage", { MAIL_READ_ONLY: "1" })).code).toBe(5)
    expect((await ack("triage", { AI_AGENT: "claude-code_2-1_agent" })).code).toBe(5)
    expect((await ack("triage", scheduled)).code).toBe(0)
    expect((await ack("digest", {})).code).toBe(0)
  })

  it("wakes a holder only for mail it reads, without moving its mark; moving past skipped mail is its own step", async () => {
    const box = await mailbox()
    await box.synced()
    const waiting = () => box.withStore((store) => mailWaiting(store, "triage"))
    expect(await waiting()).toMatchObject({ unmarked: true, emails: 0 })
    const { cursor } = await read(box)
    await box.cli(["messages", "acknowledge", "--holder", "triage", "--cursor", cursor])
    expect(await waiting()).toEqual({ unmarked: false, emails: 0, oldestStoredAt: null })

    await box.thread("t-bulk", email("bulk", 1, { mailboxes: [BULK], subject: "Скидки до 50%: успейте" }))
    await box.synced()
    const before = (await box.withStore((store) => marksOf(store, MINE)))[0]?.throughId
    expect((await waiting()).emails).toBe(0)
    expect((await box.withStore((store) => marksOf(store, MINE)))[0]?.throughId).toBe(before)
    await box.withStore((store) => advancePastSkipped(store, "triage"))
    expect((await box.withStore((store) => marksOf(store, MINE)))[0]?.skipped.bulk).toBe(1)

    await box.thread("t-ann", email("ann", 1))
    await box.thread("t-bob", email("bob", 1))
    await box.synced()
    const two = await waiting()
    expect(two.emails).toBe(2)
    expect(two.oldestStoredAt).toBeGreaterThan(Date.now() - HOUR)
  })

  it("keeps a suspicious sender's emails on the mark and offers them again once the score is cleared", async () => {
    const box = await mailbox()
    await box.synced()
    const ack = async (cursor: string) =>
      expect((await box.cli(["messages", "acknowledge", "--holder", "triage", "--cursor", cursor])).code).toBe(0)
    await ack((await read(box)).cursor)
    await box.thread("t-scam", email("scam", 1, { from: { address: "scam@example.net", name: null } }))
    const score = (demoted: boolean) =>
      box.withStore((store) =>
        store.mail.setSenderScores(
          box.accountId,
          [{ address: "scam@example.net", score: demoted ? 9 : 0, signals: [], demoted }],
          Date.now(),
        ),
      )
    await score(true)
    await box.synced()
    const doubted = await read(box)
    expect(doubted.answer.items).toEqual([])
    await ack(doubted.cursor)
    expect((await box.withStore((store) => marksOf(store, MINE)))[0]).toMatchObject({
      skipped: { suspicious: 1 },
      suspicious: [expect.any(Number)],
    })

    await score(false)
    expect((await box.withStore((store) => mailWaiting(store, "triage"))).emails).toBe(1)
    const cleared = await read(box)
    expect(texts(cleared.answer)).toEqual(["text of scam"])
    await ack(cleared.cursor)
    expect((await box.withStore((store) => marksOf(store, MINE)))[0]).toMatchObject({
      read: 1,
      suspicious: [],
      skipped: { suspicious: 1 },
    })
  })
})

describe("the steps a review hands on", () => {
  const steps = (out: string) =>
    (JSON.parse(out) as { next?: { step: string; command: string; args: Record<string, unknown>; line?: string }[] })
      .next ?? []

  it("in a mail CLI, run the profile's own commands", async () => {
    const box = await mailbox()
    await box.thread("t-1", email("one", 1))
    await box.synced()
    const [acknowledge] = steps((await box.cli(["review", "--holder", "triage"])).out)
    expect(acknowledge).toMatchObject({ step: "mail-messages.acknowledge", command: "messages acknowledge" })
    expect(acknowledge?.line).toMatch(/^mail ya messages acknowledge --holder triage --cursor /)
    expect(steps((await box.cli(["review", "date>2h"])).out)).toMatchObject([
      { step: "mail-review.next", command: "review", line: expect.stringMatching(/^mail ya review /) },
    ])
  })

  it("offers one thread to read whole and names the other cut threads under missing", async () => {
    const box = await mailbox()
    const long = (thread: string) =>
      Array.from({ length: 51 }, (_, n) => email(`${thread}-${n}`, 2 - n / 100, { subject: thread }))
    await box.thread("t-a", ...long("t-a"))
    await box.thread("t-b", ...long("t-b"))
    await box.thread("t-c", ...long("t-c"))
    await box.synced()

    const answer = JSON.parse((await box.cli(["review", "date>1d"])).out) as {
      next: { step: string }[]
      missing: { why: string; step?: string }[]
    }

    expect(answer.next.map((one) => one.step)).toEqual(["mail-review.next", "mail-conversations.show"])
    const cut = answer.missing.find((one) => one.step === "mail-conversations.show")?.why ?? ""
    expect(cut).toContain("3 thread(s)")
    expect(cut.match(/chat:email\//g)).toHaveLength(2)
  })

  it("in a host, run where it mounted them, naming the mailbox", async () => {
    const box = await mailbox(MEMO_MOUNT)
    await box.thread("t-1", email("one", 1))
    await box.synced()
    const held = await box.cli(["mail", "review", "--holder", "triage", "--source", "email:me@example.com"])
    expect(held.code, held.err).toBe(0)
    const [acknowledge] = steps(held.out)
    expect(acknowledge).toMatchObject({
      command: "messages acknowledge",
      args: { holder: "triage", source: "email:me@example.com" },
    })
    const done = await box.cli([
      "messages",
      "acknowledge",
      "--holder",
      "triage",
      "--cursor",
      String(acknowledge?.args.cursor),
      "--source",
      "email:me@example.com",
    ])
    expect(done.code, done.err).toBe(0)
    const dated = await box.cli(["mail", "review", "date>2h", "--source", "email:me@example.com"])
    expect(steps(dated.out)).toMatchObject([
      { step: "mail-review.next", command: "mail review", args: { source: "email:me@example.com" } },
    ])
  })
})
