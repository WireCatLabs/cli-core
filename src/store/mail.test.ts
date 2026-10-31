import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { migrate } from "./migrations.js"
import { type EmailFilter, type EmailInput, emailHitsByPk, mailStoreOver, type ThreadSave } from "./sqlite/emails.js"
import { openSqlite } from "./sqlite/open.js"
import { openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close()
})

const freshPath = () => join(mkdtempSync(join(tmpdir(), "mail-")), "store.db")

const seeded = async () => {
  const { database, orm } = await openSqlite(freshPath())
  opened.push(database)
  migrate(database)
  database
    .prepare("INSERT INTO accounts (id, provider, external_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)")
    .run(1, "email", "owner@example.com", "Owner Example")
  return { database, mail: mailStoreOver({ database, orm, now: () => 1 }) }
}

const email = (overrides: Partial<EmailInput> = {}): EmailInput => ({
  externalId: "<first@example.com>",
  subject: "Quarterly planning",
  from: { address: "Alice@Example.com", name: "Alice Example" },
  to: [{ address: "owner@example.com", name: null }],
  cc: [{ address: "bob@example.com", name: "Bob Sample" }],
  sentAt: 1000,
  receivedAt: 1100,
  references: [],
  bodyText: "Let us agree on the roadmap.",
  outgoing: false,
  read: true,
  mailboxes: [{ externalId: "INBOX", name: "Inbox", kind: "inbox" }],
  ...overrides,
})

const thread = (emails: EmailInput[], now = 2000): ThreadSave => ({ accountId: 1, externalId: "thread-1", emails, now })

describe("mail store", () => {
  it("saves several threads and the sync state in one transaction, or none of them", async () => {
    const { mail, database } = await seeded()
    const state = (value: string) => [{ accountId: 1, name: "cursor", value }]
    const saved = await mail.saveThreads(
      [thread([email()]), { ...thread([email({ externalId: "<two@example.com>" })]), externalId: "thread-2" }],
      state("a"),
    )
    expect(saved.map(({ thread }) => thread.externalId)).toEqual(["thread-1", "thread-2"])

    const broken = { ...thread([email({ externalId: "<three@example.com>" })]), externalId: "thread-3" }
    await expect(mail.saveThreads([broken, { ...thread([email()]), accountId: 0 }], state("b"))).rejects.toThrow(
      "Invalid thread key",
    )
    expect((await mail.threads()).map(({ externalId }) => externalId).sort()).toEqual(["thread-1", "thread-2"])
    expect(database.prepare("SELECT value FROM sync_cursors WHERE key = 'cursor'").get()).toMatchObject({ value: "a" })
  })

  it("saves a thread with its emails, recipients and mailboxes, and a resave changes nothing", async () => {
    const { mail } = await seeded()
    const first = await mail.saveThread(thread([email()]))
    expect(first.thread).toMatchObject({ subject: "Quarterly planning", emailsCount: 1, lastEmailAt: 1000 })
    const [saved] = first.emails
    expect(saved).toMatchObject({ fromAddress: "alice@example.com", read: true, outgoing: false, references: [] })
    expect(saved?.recipients.map(({ address, role, position }) => [address, role, position])).toEqual([
      ["owner@example.com", "to", 0],
      ["bob@example.com", "cc", 1],
    ])
    expect(saved?.mailboxes.map(({ externalId }) => externalId)).toEqual(["INBOX"])

    const again = await mail.saveThread(thread([email()], 3000))
    expect(again.thread.id).toBe(first.thread.id)
    expect(again.emails.map(({ id }) => id)).toEqual(first.emails.map(({ id }) => id))
    expect(again.emails[0]?.recipients).toEqual(saved?.recipients)
    expect(again.thread.emailsCount).toBe(1)
    expect(await mail.thread(first.thread.id)).toEqual(again)
  })

  it("adds replies and mailboxes, keeps the thread's subject and time, and reads by Message-ID", async () => {
    const { mail } = await seeded()
    const reply = email({ subject: "Re: Quarterly planning", externalId: "<reply@example.com>", sentAt: 5000 })
    await mail.saveThread(thread([reply, email()]))
    const details = await mail.saveThread(
      thread([email({ mailboxes: [{ externalId: "Label_1", name: "Projects", kind: "label" }] })], 6000),
    )
    expect(details.thread).toMatchObject({ subject: "Quarterly planning", emailsCount: 2, lastEmailAt: 5000 })
    expect(details.emails.map(({ externalId }) => externalId)).toEqual(["<first@example.com>", "<reply@example.com>"])
    expect((await mail.email(1, "<first@example.com>"))?.mailboxes.map(({ name }) => name)).toEqual([
      "Inbox",
      "Projects",
    ])
    expect(await mail.email(1, "<missing@example.com>")).toBeNull()
    expect((await mail.threads({ accountId: 1 })).map(({ id }) => id)).toEqual([details.thread.id])
    expect(await mail.threads({ accountId: 2 })).toEqual([])
  })

  it("searches subjects and bodies by word prefix, and an email marked deleted leaves the results", async () => {
    const { mail } = await seeded()
    await mail.saveThread(
      thread([email(), email({ externalId: "<second@example.com>", subject: "Lunch", bodyText: "Pizza on Friday" })]),
    )
    expect((await mail.search("quarterly")).map(({ externalId }) => externalId)).toEqual(["<first@example.com>"])
    expect((await mail.search("roadm")).map(({ externalId }) => externalId)).toEqual(["<first@example.com>"])
    expect((await mail.search("pizza friday")).map(({ externalId }) => externalId)).toEqual(["<second@example.com>"])
    expect(await mail.search("  ")).toEqual([])

    expect(await mail.markDeleted(1, ["<second@example.com>"], 7000)).toBe(1)
    expect(await mail.search("pizza")).toEqual([])
    expect((await mail.threads())[0]?.emailsCount).toBe(1)

    await mail.saveThread(thread([email({ bodyText: "The roadmap changed to a timeline." })], 8000))
    expect((await mail.search("timeline")).map(({ externalId }) => externalId)).toEqual(["<first@example.com>"])

    await mail.markDeleted(1, ["<first@example.com>"], 9000)
    expect(await mail.threads()).toEqual([])
    expect((await mail.threads({ includeDeleted: true }))[0]?.deletedAt).toBe(9000)

    expect(await mail.markRestored(1, ["<first@example.com>", "<unknown@example.com>"], 10_000)).toBe(1)
    expect(await mail.markRestored(1, ["<first@example.com>"], 11_000)).toBe(0)
    expect((await mail.threads())[0]).toMatchObject({ deletedAt: null, emailsCount: 1 })
    expect((await mail.emailRefs({ accountId: 1 })).map(({ externalId }) => externalId)).toEqual([
      "<first@example.com>",
    ])
  })

  it("lists emails by thread, participant, mailbox and received time", async () => {
    const { mail } = await seeded()
    await mail.saveThread(
      thread([
        email(),
        email({
          externalId: "<second@example.com>",
          from: { address: "carol@example.com", name: null },
          to: [],
          cc: [],
          sentAt: 3000,
          receivedAt: 3100,
          mailboxes: [{ externalId: "Label_1", name: "Projects", kind: "label" }],
        }),
      ]),
    )
    await mail.saveThread({ ...thread([email({ externalId: "<other@example.com>", sentAt: 4000 })]), externalId: "t2" })
    const ids = async (filter: EmailFilter) => (await mail.emails(filter)).map(({ externalId }) => externalId)

    expect(await ids({ accountId: 1 })).toEqual(["<other@example.com>", "<second@example.com>", "<first@example.com>"])
    expect(await ids({ threadExternalId: "thread-1" })).toEqual(["<second@example.com>", "<first@example.com>"])
    expect(await ids({ participant: "Bob@Example.com" })).toEqual(["<other@example.com>", "<first@example.com>"])
    expect(await ids({ participant: "carol@example.com" })).toEqual(["<second@example.com>"])
    expect(await ids({ mailbox: "Label_1" })).toEqual(["<second@example.com>"])
    expect(await ids({ since: 1100, until: 3100 })).toEqual(["<other@example.com>", "<first@example.com>"])
    expect((await mail.mailboxes(1)).map(({ name }) => name)).toEqual(["Inbox", "Projects"])

    await mail.markDeleted(1, ["<first@example.com>"], 5000)
    expect(await ids({ threadExternalId: "thread-1" })).toEqual(["<second@example.com>"])
    expect(await ids({ threadExternalId: "thread-1", includeDeleted: true })).toHaveLength(2)
    const found = async (participant: string) =>
      (await mail.search("roadmap", { participant })).map(({ externalId }) => externalId)
    expect(await found("carol@example.com")).toEqual(["<second@example.com>"])
    expect(await found("bob@example.com")).toEqual(["<other@example.com>"])
  })

  it("keeps a sender's score per account and shows it on that sender's email hits", async () => {
    const { database, mail } = await seeded()
    await mail.saveThread(
      thread([email({ headers: { "reply-to": "desk@elsewhere.example", dkim: "fail", dmarc: "fail" } })]),
    )
    const hitOf = async () => emailHitsByPk(database, [(await mail.emails({ accountId: 1 }))[0]?.id as number])[0]
    expect((await hitOf())?.email?.senderScore).toBeUndefined()

    expect(
      await mail.setSenderScores(1, [{ address: "alice@example.com", score: 5, signals: ["dmarc_fail"] }], 3000),
    ).toBe(1)

    expect((await hitOf())?.email?.senderScore).toEqual({ score: 5, signals: ["dmarc_fail"] })
    await mail.setSenderScores(
      1,
      [{ address: "alice@example.com", score: 8, signals: ["young_domain"], demoted: true }],
      4000,
    )
    expect((await hitOf())?.email?.senderScore).toEqual({ score: 8, signals: ["young_domain"], demoted: true })
    expect((await mail.emailFacts({ accountId: 1 }))[0]).toMatchObject({
      replyTo: "desk@elsewhere.example",
      dkim: "fail",
      dmarc: "fail",
    })
  })

  it("lists references with mailboxes and the deleted mark, without text", async () => {
    const { mail } = await seeded()
    await mail.saveThread(
      thread([
        email(),
        email({
          externalId: "<second@example.com>",
          receivedAt: 3100,
          mailboxes: [{ externalId: "Label_1", name: "Projects", kind: "label" }],
        }),
      ]),
    )
    await mail.markDeleted(1, ["<first@example.com>"], 5000)

    expect(await mail.emailRefs({ accountId: 1 })).toEqual([
      { externalId: "<second@example.com>", deleted: false, mailboxes: [{ externalId: "Label_1", kind: "label" }] },
    ])
    expect((await mail.emailRefs({ accountId: 1, includeDeleted: true })).map(({ deleted }) => deleted).sort()).toEqual(
      [false, true],
    )
    expect(await mail.emailRefs({ accountId: 1, since: 3200 })).toEqual([])
  })

  it("lists the facts a mail rule reads, oldest first, without text", async () => {
    const { mail } = await seeded()
    await mail.saveThread(
      thread([
        email({ externalId: "<new@example.com>", receivedAt: 3100 }),
        email({
          externalId: "<old@example.com>",
          receivedAt: 3000,
          size: 1200,
          flagged: true,
          metadata: { listId: "news.example.com" },
          mailboxes: [{ externalId: "Label_1", name: "Projects", kind: "label" }],
        }),
      ]),
    )

    const [old, recent] = await mail.emailFacts({ accountId: 1 })
    expect(old).toMatchObject({
      externalId: "<old@example.com>",
      receivedAt: 3000,
      size: 1200,
      flagged: true,
      listId: "news.example.com",
      fromAddress: "alice@example.com",
      recipients: ["owner@example.com", "bob@example.com"],
      mailboxes: [{ externalId: "Label_1", name: "Projects", kind: "label" }],
    })
    expect(recent?.externalId).toBe("<new@example.com>")
    expect(recent?.listId).toBeNull()
  })

  it("sets membership only among the scanned mailboxes", async () => {
    const { mail } = await seeded()
    const archive = { externalId: "Archive", name: "Archive", kind: "archive" }
    await mail.saveThread(
      thread([email({ mailboxes: [{ externalId: "INBOX", name: "Inbox", kind: "inbox" }, archive] })]),
    )
    const scanned = [{ externalId: "INBOX", name: "Inbox", kind: "inbox" }]

    expect(await mail.setMailboxes(1, scanned, new Map([["<first@example.com>", []]]), 3000)).toBe(1)
    expect((await mail.email(1, "<first@example.com>"))?.mailboxes.map(({ externalId }) => externalId)).toEqual([
      "Archive",
    ])

    expect(await mail.setMailboxes(1, scanned, new Map([["<first@example.com>", ["INBOX"]]]), 4000)).toBe(1)
    expect((await mail.email(1, "<first@example.com>"))?.mailboxes.map(({ externalId }) => externalId)).toEqual([
      "INBOX",
      "Archive",
    ])
    expect(await mail.setMailboxes(1, scanned, new Map([["<missing@example.com>", ["INBOX"]]]), 5000)).toBe(0)
    await expect(mail.setMailboxes(1, scanned, new Map([["<first@example.com>", ["Archive"]]]), 6000)).rejects.toThrow(
      "Mailbox Archive was not scanned",
    )
  })

  it("replaces an email's attachments when given and finds their text by word", async () => {
    const { database, mail } = await seeded()
    const file = (position: number, name: string, text: string | null) => ({
      position,
      kind: "file",
      mime: "application/pdf",
      name,
      title: null,
      url: null,
      size: 10,
      width: null,
      height: null,
      duration: null,
      providerRef: { part: position + 2 },
      localPath: null,
      text,
      normalizedText: null,
      extraction: text === null ? null : "text",
      extractor: text === null ? null : "pdf:unpdf",
      extractionError: text === null ? "no_text" : null,
      contentSha256: null,
      extractedAt: 1500,
    })
    await mail.saveThread(
      thread([email({ attachments: [file(0, "plan.pdf", "Café budget"), file(1, "scan.pdf", null)] })]),
    )
    expect(
      (await mail.emailRefs({ accountId: 1, attachmentErrors: ["no_text"] })).map(({ externalId }) => externalId),
    ).toEqual(["<first@example.com>"])
    expect(await mail.emailRefs({ accountId: 1, attachmentErrors: ["engine-missing"] })).toEqual([])
    const saved = await mail.email(1, "<first@example.com>")
    expect(
      saved?.attachments.map(({ name, normalizedText, providerRef }) => [name, normalizedText, providerRef]),
    ).toEqual([
      ["plan.pdf", "cafe budget", { part: 2 }],
      ["scan.pdf", null, { part: 3 }],
    ])
    const words = database.prepare("SELECT rowid FROM attachment_words WHERE attachment_words MATCH 'cafe'").all()
    expect(words.map(({ rowid }) => Number(rowid))).toEqual([saved?.attachments[0]?.id])

    await mail.saveThread(thread([email({ attachments: [file(0, "plan-v2.pdf", "Budget")] })], 3000))
    expect((await mail.email(1, "<first@example.com>"))?.attachments.map(({ name }) => name)).toEqual(["plan-v2.pdf"])
    await mail.saveThread(thread([email()], 4000))
    expect((await mail.email(1, "<first@example.com>"))?.attachments).toHaveLength(1)
  })

  it("drops a deleted email's text and attachment text, and a save brings the email back", async () => {
    const { database, mail } = await seeded()
    const file = {
      position: 0,
      kind: "file",
      mime: "text/plain",
      name: "notes.txt",
      title: null,
      url: null,
      size: 5,
      width: null,
      height: null,
      duration: null,
      providerRef: null,
      localPath: null,
      text: "Secret plan",
      normalizedText: null,
      extraction: "text",
      extractor: "plain",
      extractionError: null,
      contentSha256: null,
      extractedAt: 1500,
    }
    await mail.saveThread(thread([email({ bodyHtml: "<p>roadmap</p>", snippet: "Let us", attachments: [file] })]))
    const pieces = () =>
      database.prepare("SELECT content_hash AS hash FROM chunks WHERE chunkable_type = 'attachment'").all()
    const [piece] = pieces()
    expect(piece).toBeDefined()
    database
      .prepare(
        "INSERT INTO embeddings (content_hash, model, dims, vector, created_at, updated_at) VALUES (?, 'test:model:2', 2, ?, 1, 1)",
      )
      .run(String(piece?.hash), new Uint8Array(8))
    await mail.markDeleted(1, ["<first@example.com>"], 3000)
    expect(pieces()).toEqual([])
    expect(database.prepare("SELECT count(*) AS n FROM embeddings").get()?.n).toBe(0)

    const gone = await mail.email(1, "<first@example.com>")
    expect(gone).toMatchObject({ deletedAt: 3000, bodyText: null, bodyHtml: null, snippet: null })
    expect(gone?.attachments[0]).toMatchObject({ text: null, normalizedText: null })
    expect(database.prepare("SELECT rowid FROM attachment_words WHERE attachment_words MATCH 'secret'").all()).toEqual(
      [],
    )

    const back = await mail.saveThread(thread([email()], 4000))
    expect(back.emails[0]).toMatchObject({ deletedAt: null, bodyText: "Let us agree on the roadmap." })
    expect(back.thread).toMatchObject({ deletedAt: null, emailsCount: 1 })
    expect((await mail.search("roadmap")).map(({ externalId }) => externalId)).toEqual(["<first@example.com>"])
  })

  it("sets read and flagged on stored emails, leaving a flag that is not given", async () => {
    const { mail } = await seeded()
    await mail.saveThread(thread([email({ read: false, flagged: false })]))
    expect(await mail.setFlags(1, new Map([["<first@example.com>", { read: true }]]), 3000)).toBe(1)
    expect(await mail.email(1, "<first@example.com>")).toMatchObject({ read: true, flagged: false })
    expect(await mail.setFlags(1, new Map([["<first@example.com>", { read: true, flagged: true }]]), 4000)).toBe(1)
    expect(await mail.email(1, "<first@example.com>")).toMatchObject({ read: true, flagged: true, updatedAt: 4000 })
    expect(await mail.setFlags(1, new Map([["<first@example.com>", { read: true, flagged: true }]]), 5000)).toBe(0)
    expect(await mail.setFlags(1, new Map([["<missing@example.com>", { read: true }]]), 5000)).toBe(0)
  })

  it("cuts the text of attachments saved before attachments had pieces, once", async () => {
    const { database, mail } = await seeded()
    await mail.saveThread(thread([email()]))
    const id = Number((await mail.email(1, "<first@example.com>"))?.id)
    database
      .prepare(
        "INSERT INTO attachments (attachable_type, attachable_id, position, kind, name, text, created_at, updated_at) VALUES ('email', ?, 0, 'file', 'old.txt', 'An old budget file', 1, 1)",
      )
      .run(id)
    const pieces = () =>
      Number(database.prepare("SELECT count(*) AS n FROM chunks WHERE chunkable_type = 'attachment'").get()?.n)
    expect(pieces()).toBe(0)
    await mail.chunksToEmbed("test:model:2", { limit: 10 })
    expect(pieces()).toBe(1)
    await mail.chunksToEmbed("test:model:2", { limit: 10 })
    expect(pieces()).toBe(1)
  })

  it("cuts a store cut the older ways again, and drops the vectors of the pieces it no longer has", async () => {
    const { database, mail } = await seeded()
    await mail.saveThread(thread([email()]))
    await mail.chunksToEmbed("test:model:2", { limit: 10 })
    const id = Number((await mail.email(1, "<first@example.com>"))?.id)
    const current = () =>
      database
        .prepare("SELECT chunkable_type AS type, content_hash AS hash FROM chunks ORDER BY type, hash")
        .all()
        .map(({ type, hash }) => `${type}:${hash}`)
    const cut = current()
    database.prepare("UPDATE chunks SET content_hash = 'thread-hash' WHERE chunkable_type = 'email_thread'").run()
    database
      .prepare(
        `INSERT INTO chunks (chunkable_type, chunkable_id, position, start_offset, end_offset, content_hash, account_id,
           created_at, updated_at) VALUES ('email', ?, 0, 0, 10, 'email-hash', 1, 1, 1)`,
      )
      .run(id)
    for (const hash of ["thread-hash", "email-hash"])
      database
        .prepare(
          "INSERT INTO embeddings (model, content_hash, dims, vector, created_at, updated_at) VALUES ('m', ?, 2, x'00', 1, 1)",
        )
        .run(hash)
    database.prepare("DELETE FROM store_settings WHERE key = 'mail_pieces_cut'").run()
    await mail.chunksToEmbed("test:model:2", { limit: 10 })
    expect(current()).toEqual(cut)
    expect(database.prepare("SELECT count(*) AS n FROM embeddings").get()?.n).toBe(0)
  })

  it("refuses an empty key and leaves nothing behind", async () => {
    const { mail } = await seeded()
    await expect(mail.saveThread(thread([email(), email({ externalId: "" })]))).rejects.toThrow("Invalid email key")
    expect(await mail.threads({ includeDeleted: true })).toEqual([])
    await expect(mail.saveThread({ ...thread([]), externalId: "" })).rejects.toThrow("Invalid thread key")
  })

  it("is the shared store's mail, built on first use", async () => {
    const store = await openStore({ path: freshPath() })
    opened.push(store)
    expect(await store.mail.threads()).toEqual([])
    expect(store.mail).toBe(store.mail)
  })
})
