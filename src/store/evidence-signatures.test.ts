import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import type { CacheDatabase } from "./driver.js"
import { openCache } from "./open.js"
import { orphanPointers } from "./sqlite/entity-types.js"
import {
  evidenceSignature,
  quoteKept,
  resignEvidence,
  sourceTextAt,
  storedEvidenceMetadata,
} from "./sqlite/evidence-signature.js"
import { referenceOfThing, type Thing } from "./sqlite/things.js"
import { type MessageStore, openStore } from "./store.js"

const MESSAGE: Message = {
  id: "m1",
  chatId: "c",
  senderId: "7",
  senderName: "Kai Sample",
  timestamp: "2026-11-01T10:00:00.000Z",
  editedAt: null,
  text: "",
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}

const opened: { store: MessageStore; db: CacheDatabase }[] = []
afterEach(async () => {
  for (const { store, db } of opened.splice(0)) {
    db.close()
    await store.close()
  }
})

const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "evidence-signatures-")), "store.db")
  const clock = { at: 1_000 }
  const store = await openStore({ path, now: () => clock.at })
  const db = await openCache(path)
  opened.push({ store, db })
  const account = await store.accounts.saveAccount({ provider: "example-chat", account: "example" }, { name: "Ex" })
  const run = (statement: string, ...values: (string | number | null)[]) => db.prepare(statement).run(...values)
  const inserted = (statement: string, ...values: (string | number | null)[]) =>
    Number(db.prepare(`${statement} RETURNING id`).get(...values)?.id)
  const cite = async (thing: Thing, quote?: string) => {
    const ref = referenceOfThing(db, thing) as string
    const memory = await store.memories.add({
      kind: "preference",
      body: "Kai Sample prefers Thursday calls",
      scope: "work",
      evidence: [quote === undefined ? ref : { ref, quote }],
      author: "owner",
      status: "confirmed",
    })
    const link = db
      .prepare("SELECT id, metadata FROM links WHERE from_type = 'memory' AND from_id = ? AND kind = 'evidence'")
      .get(Number(memory.id))
    return { memory, ref, link: Number(link?.id), stored: storedEvidenceMetadata(link?.metadata) }
  }
  const signed = (thing: Thing) => evidenceSignature(db, thing)
  return { store, db, clock, account, run, inserted, cite, signed }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

const changes = async (f: Fixture, thing: Thing, change: () => unknown, expected: { deleted?: boolean } = {}) => {
  const cited = f.clock.at
  const { stored } = await f.cite(thing)
  expect(stored).toMatchObject({ v: 1, sig: f.signed(thing).sig, checked_at: cited })
  f.clock.at = cited + 1_000
  await change()
  const now = f.signed(thing)
  expect(now.sig).not.toBe(stored?.sig)
  expect(now.deleted).toBe(expected.deleted ?? false)
  return { stored, now }
}

describe("an evidence link's signature", () => {
  it("of a note follows its revision and records the revision cited", async () => {
    const f = await fixture()
    const note = await f.store.notes.addNote({ text: "Kai Sample prefers Thursdays" })
    const thing = { type: "note" as const, id: Number(note.id) }
    const { stored, now } = await changes(f, thing, async () => {
      await f.store.notes.editNote(note.ref, "Kai Sample prefers Fridays", 1)
    })
    expect(stored?.rev).toBe(1)
    expect(now).toMatchObject({ rev: 2, changedAt: 2_000 })
  })

  it("of a document follows its content hash and revision, and its deletion", async () => {
    const f = await fixture()
    const id = f.inserted(
      "INSERT INTO documents (account_id, external_id, kind, body, content_hash, created_at, updated_at) " +
        "VALUES (?, 'plan.md', 'file', 'Thursdays', 'h1', 0, 0)",
      f.account,
    )
    const thing = { type: "document" as const, id }
    await changes(f, thing, () => f.run("UPDATE documents SET content_hash = 'h2' WHERE id = ?", id))
    f.run("UPDATE documents SET deleted_at = 3000 WHERE id = ?", id)
    expect(f.signed(thing)).toMatchObject({ deleted: true, changedAt: 3_000 })
  })

  it("of a message follows each edit the store saves, with or without an edit time, and its deletion", async () => {
    const f = await fixture()
    const key = { provider: "example-chat", account: "example" }
    const save = (text: string, editedAt: string | null = null) =>
      f.store.messages.saveMessages(key, "c", [{ ...MESSAGE, text, editedAt }], { via: "update" })
    await save("delivery on the 28th")
    const id = Number(f.db.prepare("SELECT id FROM messages WHERE external_id = 'm1'").get()?.id)
    const thing = { type: "message" as const, id }
    const { stored, now } = await changes(f, thing, () => save("delivery on the 30th"))
    expect(stored?.rev).toBe(0)
    expect(now).toMatchObject({ changedAt: 2_000 })
    expect(now.rev).toBeGreaterThan(0)
    const unedited = f.signed(thing)
    f.clock.at = 2_500
    await save("delivery on the 31st", "2026-11-07T10:00:00.000Z")
    expect(f.signed(thing).sig).not.toBe(unedited.sig)
    f.clock.at = 3_000
    await f.store.messages.markDeleted(key, ["m1"], { chatId: "c" })
    expect(f.signed(thing)).toMatchObject({ deleted: true })
  })

  it("of a meeting transcript, or one line of it, follows the transcript's content hash", async () => {
    const f = await fixture()
    const meeting = f.inserted(
      "INSERT INTO meetings (account_id, external_id, title, created_at, updated_at) VALUES (?, 'mt', 'Sync', 0, 0)",
      f.account,
    )
    const transcript = f.inserted(
      "INSERT INTO meeting_transcripts (meeting_id, source, content_hash, created_at, updated_at) VALUES (?, 'zoom', 'h1', 0, 0)",
      meeting,
    )
    const line = f.inserted(
      "INSERT INTO meeting_transcript_rows (meeting_transcript_id, position, start_ms, end_ms, text, created_at) " +
        "VALUES (?, 0, 0, 1000, 'delivery on the 28th', 0)",
      transcript,
    )
    const whole = { type: "meeting_transcript" as const, id: transcript }
    const cue = { type: "meeting_transcript_row" as const, id: line }
    await changes(f, cue, () => f.run("UPDATE meeting_transcripts SET content_hash = 'h2' WHERE id = ?", transcript))
    expect(f.signed(cue).sig.endsWith(f.signed(whole).sig)).toBe(true)
    f.run("DELETE FROM meeting_transcript_rows WHERE id = ?", line)
    expect(f.signed(cue)).toMatchObject({ sig: "gone", deleted: true })
  })

  it("of a calendar event follows its entries' latest revision and its deletion at the source", async () => {
    const f = await fixture()
    const calendar = f.inserted(
      "INSERT INTO calendars (account_id, external_id, primary_calendar, synced, created_at, updated_at) VALUES (?, 'cal', 1, 1, 0, 0)",
      f.account,
    )
    const event = f.inserted(
      "INSERT INTO events (title, origin, created_at, updated_at) VALUES ('Delivery', 'calendar', 0, 0)",
    )
    const entry = f.inserted(
      "INSERT INTO calendar_entries (calendar_id, kind, event_id, external_id, exception, status, all_day, created_at, updated_at) " +
        "VALUES (?, 'single', ?, 'e1', 0, 'confirmed', 0, 0, 0)",
      calendar,
      event,
    )
    const thing = { type: "event" as const, id: event }
    const { now } = await changes(f, thing, () =>
      f.run("INSERT INTO calendar_entry_revisions (entry_id, title, created_at) VALUES (?, 'Delivery', 2000)", entry),
    )
    expect(now).toMatchObject({ changedAt: 2_000 })
    f.run("UPDATE events SET source_deleted_at = 3000 WHERE id = ?", event)
    expect(f.signed(thing)).toMatchObject({ deleted: true, changedAt: 3_000 })
  })

  it("of a thing an import made follows the source's record", async () => {
    const f = await fixture()
    const organization = f.inserted(
      "INSERT INTO organizations (kind, name, created_at, updated_at) VALUES ('company', 'Example Ltd', 0, 0)",
    )
    const record = f.inserted(
      "INSERT INTO records (account_id, type, external_id, fields, revision, fingerprint, entity_type, entity_id, batch_id, " +
        "created_at, updated_at) VALUES (?, 'organization', 'o1', '{}', 1, 'fp1', 'organization', ?, 'b', 0, 0)",
      f.account,
      organization,
    )
    const thing = { type: "organization" as const, id: organization }
    const { stored } = await changes(f, thing, () =>
      f.run("UPDATE records SET fingerprint = 'fp2', revision = 2, updated_at = 2000 WHERE id = ?", record),
    )
    expect(stored?.rev).toBe(1)
    f.run("UPDATE records SET deleted_at = 3000 WHERE id = ?", record)
    expect(f.signed(thing).deleted).toBe(true)
  })

  it("of an email, a meeting, a person or a project says only whether it still exists", async () => {
    const f = await fixture()
    const project = await f.store.knowledge.addProject({ name: "Harbour" })
    const thing = { type: "project" as const, id: Number(project.id) }
    const before = f.signed(thing)
    f.run("UPDATE projects SET name = 'Renamed' WHERE id = ?", thing.id)
    expect(f.signed(thing)).toEqual(before)
    await changes(f, thing, () => f.run("UPDATE projects SET deleted_at = 2000 WHERE id = ?", thing.id), {
      deleted: true,
    })
    expect(f.signed({ type: "person", id: 999_999 })).toMatchObject({ sig: "gone", deleted: true })
  })

  it("of a fact or a memory follows its status", async () => {
    const f = await fixture()
    const note = await f.store.notes.addNote({ text: "Kai Sample prefers Thursdays" })
    const cited = await f.store.memories.add({
      kind: "preference",
      body: "Kai Sample prefers Thursdays",
      scope: "work",
      evidence: [note.ref],
      author: "owner",
      status: "confirmed",
    })
    const fact = await f.store.facts.add({ type: "decision", statement: "Thursdays it is", by: "owner" })
    await changes(f, { type: "memory", id: Number(cited.id) }, () => f.store.memories.markStale(cited.ref, "owner"))
    await changes(f, { type: "fact", id: Number(fact.id) }, () => f.store.facts.reverse(fact.ref, "owner"))
  })
})

describe("citing evidence", () => {
  it("keeps the quote given with a reference, and plain references read back as before", async () => {
    const f = await fixture()
    const note = await f.store.notes.addNote({ text: "We agreed delivery on the 28th" })
    const { memory, stored } = await f.cite({ type: "note", id: Number(note.id) }, "  delivery on the 28th ")
    expect(stored).toEqual({
      v: 1,
      sig: "1000||1|",
      rev: 1,
      cited_rev: 1,
      quote: "delivery on the 28th",
      checked_at: 1_000,
    })
    expect(memory.evidence).toEqual([note.ref])
    const plain = await f.cite({ type: "note", id: Number(note.id) })
    expect(plain.stored).not.toHaveProperty("quote")
  })

  it("refuses an empty quote or one over 500 characters, writing nothing", async () => {
    const f = await fixture()
    const note = await f.store.notes.addNote({ text: "We agreed delivery on the 28th" })
    for (const quote of [" ", "x".repeat(501)])
      await expect(
        f.store.memories.add({
          kind: "preference",
          body: "Delivery on the 28th",
          scope: "work",
          evidence: [{ ref: note.ref, quote }],
          author: "owner",
        }),
      ).rejects.toMatchObject({ code: "validation_error", details: { reason: "evidence.quote-length" } })
    expect(await f.store.memories.list()).toEqual([])
  })

  it("refuses a quote the source never said, and takes one where the store keeps no text", async () => {
    const f = await fixture()
    const note = await f.store.notes.addNote({ text: "We agreed delivery on the 28th" })
    await expect(f.cite({ type: "note", id: Number(note.id) }, "delivery on the 30th")).rejects.toMatchObject({
      code: "validation_error",
      details: { reason: "evidence.quote-not-found" },
    })
    expect(await f.store.memories.list()).toEqual([])
    const project = await f.store.knowledge.addProject({ name: "Harbour" })
    expect((await f.cite({ type: "project", id: Number(project.id) }, "anything")).stored).toMatchObject({
      quote: "anything",
    })
  })

  it("writes a signature for a fact's evidence too", async () => {
    const f = await fixture()
    const note = await f.store.notes.addNote({ text: "We agreed delivery on the 28th" })
    const fact = await f.store.facts.add({
      type: "decision",
      statement: "Delivery on the 28th",
      by: "owner",
      evidence: [{ ref: note.ref, quote: "delivery on the 28th" }],
    })
    const link = f.db
      .prepare("SELECT metadata FROM links WHERE from_type = 'fact' AND from_id = ?")
      .get(Number(fact.id))
    expect(storedEvidenceMetadata(link?.metadata)).toMatchObject({ rev: 1, quote: "delivery on the 28th" })
    expect(fact.evidence).toEqual([note.ref])
  })

  it("signing a memory's links again queues the memory once for the involvement index", async () => {
    const f = await fixture()
    const notes = await Promise.all(
      ["one", "two", "three"].map((text) => f.store.notes.addNote({ text: `Kai Sample said ${text}` })),
    )
    const memory = await f.store.memories.add({
      kind: "preference",
      body: "Kai Sample said three things",
      scope: "work",
      evidence: notes.map((note) => note.ref),
      author: "owner",
    })
    f.run("DELETE FROM involvement_pending")
    const links = f.db
      .prepare("SELECT id, to_type, to_id FROM links WHERE from_type = 'memory' AND from_id = ?")
      .all(Number(memory.id))
    for (const link of links)
      resignEvidence(f.db, Number(link.id), f.signed({ type: "note", id: Number(link.to_id) }), 2_000, {
        v: 1,
        sig: "",
        rev: 1,
        cited_rev: 1,
        checked_at: 1_000,
      })
    expect(f.db.prepare("SELECT indexable_type, id FROM involvement_pending").all()).toEqual([
      { indexable_type: "memory", id: Number(memory.id) },
    ])
  })
})

describe("a cited source deleted", () => {
  const soft: [string, (f: Fixture) => Promise<{ thing: Thing; remove: () => unknown }>][] = [
    [
      "document",
      async (f) => {
        const id = f.inserted(
          "INSERT INTO documents (account_id, external_id, kind, body, content_hash, created_at, updated_at) " +
            "VALUES (?, 'plan.md', 'file', 'Thursdays', 'h1', 0, 0)",
          f.account,
        )
        return {
          thing: { type: "document", id },
          remove: () => f.run("UPDATE documents SET deleted_at = 2000 WHERE id = ?", id),
        }
      },
    ],
    [
      "transcript",
      async (f) => {
        const meeting = f.inserted(
          "INSERT INTO meetings (account_id, external_id, created_at, updated_at) VALUES (?, 'mt', 0, 0)",
          f.account,
        )
        const id = f.inserted(
          "INSERT INTO meeting_transcripts (meeting_id, source, content_hash, created_at, updated_at) VALUES (?, 'zoom', 'h', 0, 0)",
          meeting,
        )
        return {
          thing: { type: "meeting_transcript", id },
          remove: () => f.run("UPDATE meeting_transcripts SET deleted_at = 2000 WHERE id = ?", id),
        }
      },
    ],
    [
      "event",
      async (f) => {
        const id = f.inserted(
          "INSERT INTO events (title, origin, created_at, updated_at) VALUES ('D', 'calendar', 0, 0)",
        )
        return {
          thing: { type: "event", id },
          remove: () => f.run("UPDATE events SET deleted_at = 2000 WHERE id = ?", id),
        }
      },
    ],
    [
      "fact",
      async (f) => {
        const fact = await f.store.facts.add({ type: "decision", statement: "Thursdays", by: "owner" })
        const id = Number(fact.id)
        return {
          thing: { type: "fact", id },
          remove: () => f.run("UPDATE facts SET deleted_at = 2000 WHERE id = ?", id),
        }
      },
    ],
    [
      "memory",
      async (f) => {
        const note = await f.store.notes.addNote({ text: "Thursdays" })
        const memory = await f.store.memories.add({
          kind: "preference",
          body: "Thursdays",
          scope: "work",
          evidence: [note.ref],
          author: "owner",
        })
        const id = Number(memory.id)
        return {
          thing: { type: "memory", id },
          remove: () => f.run("UPDATE memories SET deleted_at = 2000 WHERE id = ?", id),
        }
      },
    ],
    [
      "project",
      async (f) => {
        const project = await f.store.knowledge.addProject({ name: "Harbour" })
        const id = Number(project.id)
        return {
          thing: { type: "project", id },
          remove: () => f.run("UPDATE projects SET deleted_at = 2000 WHERE id = ?", id),
        }
      },
    ],
    [
      "note",
      async (f) => {
        const note = await f.store.notes.addNote({ text: "Thursdays" })
        const id = Number(note.id)
        return {
          thing: { type: "note", id },
          remove: () => f.run("UPDATE notes SET deleted_at = 2000 WHERE id = ?", id),
        }
      },
    ],
    [
      "transcript line",
      async (f) => {
        const meeting = f.inserted(
          "INSERT INTO meetings (account_id, external_id, created_at, updated_at) VALUES (?, 'ml', 0, 0)",
          f.account,
        )
        const transcript = f.inserted(
          "INSERT INTO meeting_transcripts (meeting_id, source, content_hash, created_at, updated_at) VALUES (?, 'zoom', 'h', 0, 0)",
          meeting,
        )
        const id = f.inserted(
          "INSERT INTO meeting_transcript_rows (meeting_transcript_id, position, start_ms, end_ms, text, created_at) " +
            "VALUES (?, 0, 0, 1, 'Thursdays', 0)",
          transcript,
        )
        return {
          thing: { type: "meeting_transcript_row", id },
          remove: () => f.run("UPDATE meeting_transcripts SET deleted_at = 2000 WHERE id = ?", transcript),
        }
      },
    ],
    [
      "email",
      async (f) => {
        const mail = await f.store.accounts.saveAccount({ provider: "email", account: "example-mail" }, { name: "M" })
        f.run(
          "INSERT INTO email_threads (id, account_id, external_id, created_at, updated_at) VALUES (1, ?, 't', 0, 0)",
          mail,
        )
        const id = f.inserted(
          "INSERT INTO emails (account_id, email_thread_id, external_id, subject, body_text, sent_at, created_at, " +
            "updated_at) VALUES (?, 1, 'e', 'Harbour', 'Thursdays', 200, 0, 0)",
          mail,
        )
        return {
          thing: { type: "email", id },
          remove: () => f.run("UPDATE emails SET deleted_at = 2000 WHERE id = ?", id),
        }
      },
    ],
    [
      "meeting",
      async (f) => {
        const id = f.inserted(
          "INSERT INTO meetings (account_id, external_id, created_at, updated_at) VALUES (?, 'mm', 0, 0)",
          f.account,
        )
        return {
          thing: { type: "meeting", id },
          remove: () => f.run("UPDATE meetings SET deleted_at = 2000 WHERE id = ?", id),
        }
      },
    ],
    [
      "organization made from a record",
      async (f) => {
        const id = f.inserted(
          "INSERT INTO organizations (kind, name, created_at, updated_at) VALUES ('company', 'Example Ltd', 0, 0)",
        )
        f.run(
          "INSERT INTO records (account_id, type, external_id, fields, revision, fingerprint, entity_type, entity_id, " +
            "batch_id, created_at, updated_at) VALUES (?, 'organization', 'o1', '{}', 1, 'fp1', 'organization', ?, 'b', 0, 0)",
          f.account,
          id,
        )
        return {
          thing: { type: "organization", id },
          remove: () => f.run("UPDATE organizations SET deleted_at = 2000 WHERE id = ?", id),
        }
      },
    ],
  ]
  it.each(soft)("changes the signature of a %s marked deleted", async (_kind, made) => {
    const f = await fixture()
    const { thing, remove } = await made(f)
    await changes(f, thing, remove, { deleted: true })
  })

  it("for good keeps the citing link with no pointer and no quote, so a new row taking its id is not cited", async () => {
    const f = await fixture()
    const note = await f.store.notes.addNote({ text: "We agreed delivery on the 28th" })
    const { memory, link } = await f.cite({ type: "note", id: Number(note.id) }, "delivery on the 28th")
    f.clock.at = 2_000
    await f.store.notes.removeNote(note.ref)
    const other = await f.store.notes.addNote({ text: "Shopping list: milk" })
    expect(other.ref).toBe(note.ref)
    const row = f.db.prepare("SELECT to_type, to_id, metadata FROM links WHERE id = ?").get(link)
    expect(row).toMatchObject({ to_type: null, to_id: null })
    expect(JSON.parse(String(row?.metadata))).toEqual({
      v: 1,
      sig: "gone",
      rev: null,
      cited_rev: 1,
      checked_at: 2_000,
      gone: "note",
    })
    expect((await f.store.memories.get(memory.ref)).evidence).toEqual([])
    expect(await f.store.memories.sources(memory.ref)).toEqual([
      expect.objectContaining({ ref: null, kind: "note", missing: true }),
    ])
    expect(JSON.stringify(f.db.prepare("SELECT metadata FROM links WHERE kind = 'evidence'").all())).not.toContain(
      "28th",
    )
  })

  it("for good, as a removed fact, leaves the memory that cited it showing a missing source", async () => {
    const f = await fixture()
    const fact = await f.store.facts.add({ type: "decision", statement: "Thursdays", by: "owner" })
    const { memory } = await f.cite({ type: "fact", id: Number(fact.id) })
    expect(await f.store.facts.remove(fact.ref, "owner")).toMatchObject({ links: 0 })
    expect(await f.store.memories.sources(memory.ref)).toEqual([
      expect.objectContaining({ ref: null, kind: "fact", missing: true }),
    ])
  })

  it("as a message tombstone drops the quote and keeps the pointer, signed as deleted", async () => {
    const f = await fixture()
    const key = { provider: "example-chat", account: "example" }
    await f.store.messages.saveMessages(key, "c", [{ ...MESSAGE, text: "delivery on the 28th" }], { via: "update" })
    const id = Number(f.db.prepare("SELECT id FROM messages WHERE external_id = 'm1'").get()?.id)
    const { link } = await f.cite({ type: "message", id }, "delivery on the 28th")
    await f.store.messages.markDeleted(key, ["m1"], { chatId: "c" })
    const row = f.db.prepare("SELECT to_id, metadata FROM links WHERE id = ?").get(link)
    expect(row?.to_id).toBe(id)
    const stored = storedEvidenceMetadata(row?.metadata)
    expect(stored).not.toHaveProperty("quote")
    expect(stored?.sig).toBe(f.signed({ type: "message", id }).sig)
    expect(f.signed({ type: "message", id }).deleted).toBe(true)
  })
})

describe("the version cited", () => {
  it("stays as cited when the link is signed again, and reads back from the source's history", async () => {
    const f = await fixture()
    const note = await f.store.notes.addNote({ text: "We agreed delivery on the 28th" })
    const thing = { type: "note" as const, id: Number(note.id) }
    const { link, stored } = await f.cite(thing)
    await f.store.notes.editNote(note.ref, "We agreed delivery on the 30th", 1)
    resignEvidence(f.db, link, f.signed(thing), 2_000, stored)
    const again = storedEvidenceMetadata(f.db.prepare("SELECT metadata FROM links WHERE id = ?").get(link)?.metadata)
    expect(again).toMatchObject({ rev: 2, cited_rev: 1 })
    expect(sourceTextAt(f.db, thing, 1)).toBe("We agreed delivery on the 28th")
    expect(sourceTextAt(f.db, thing, 2)).toBe("We agreed delivery on the 30th")
  })

  it("of a message is the text before the first edit after it", async () => {
    const f = await fixture()
    const key = { provider: "example-chat", account: "example" }
    const save = (text: string) => f.store.messages.saveMessages(key, "c", [{ ...MESSAGE, text }], { via: "update" })
    await save("delivery on the 28th")
    const thing = { type: "message" as const, id: Number(f.db.prepare("SELECT id FROM messages").get()?.id) }
    const cited = f.signed(thing).rev as number
    await save("delivery on the 30th")
    await save("delivery on the 31st")
    expect(sourceTextAt(f.db, thing, cited)).toBe("delivery on the 28th")
    expect(sourceTextAt(f.db, thing, f.signed(thing).rev as number)).toBe("delivery on the 31st")
  })
})

describe("a quote still in the text", () => {
  it("is found whatever the spacing, line breaks and Unicode composition", () => {
    expect(quoteKept("delivery on\nthe  28th", "We agreed: delivery on the 28th.")).toBe(true)
    expect(quoteKept("café", "a café at noon")).toBe(true)
  })

  it("is not found once a letter, a digit or the case changed, and an empty quote is never found", () => {
    expect(quoteKept("delivery on the 28th", "delivery on the 30th")).toBe(false)
    expect(quoteKept("Delivery", "delivery")).toBe(false)
    expect(quoteKept("café", "cafe")).toBe(false)
    expect(quoteKept(" ", "anything")).toBe(false)
  })
})

describe("purging chats and accounts", () => {
  const cited = async () => {
    const f = await fixture()
    const key = { provider: "example-chat", account: "example" }
    await f.store.messages.saveMessages(key, "c", [{ ...MESSAGE, text: "delivery on the 28th" }], { via: "update" })
    const chat = Number(f.db.prepare("SELECT id FROM chats LIMIT 1").get()?.id)
    const message = Number(f.db.prepare("SELECT id FROM messages LIMIT 1").get()?.id)
    const memory = await f.store.memories.add({
      kind: "preference",
      body: "Delivery on the 28th",
      scope: "work",
      evidence: [
        referenceOfThing(f.db, { type: "chat", id: chat }) as string,
        { ref: referenceOfThing(f.db, { type: "message", id: message }) as string, quote: "delivery on the 28th" },
      ],
      author: "owner",
      status: "confirmed",
    })
    const evidence = () =>
      f.db.prepare("SELECT to_type, to_id, metadata FROM links WHERE kind = 'evidence' ORDER BY id").all()
    return { ...f, key, chat, memory, evidence }
  }
  const leavesNoPointer = async (f: Awaited<ReturnType<typeof cited>>) => {
    expect(orphanPointers(f.db).filter((orphan) => orphan.table === "links")).toEqual([])
    expect(f.evidence().map((link) => [link.to_type, link.to_id, JSON.parse(String(link.metadata)).gone])).toEqual([
      [null, null, "chat"],
      [null, null, "message"],
    ])
    expect(JSON.stringify(f.evidence())).not.toContain("28th")
    expect((await f.store.memories.sources(f.memory.ref)).every((source) => source.missing)).toBe(true)
  }

  it("of an account forgets the chats and messages it cited, leaving no pointer behind", async () => {
    const f = await cited()
    await f.store.accounts.purge(f.key)
    await leavesNoPointer(f)
  })

  it("of a chat the account left forgets it and its messages, leaving no pointer behind", async () => {
    const f = await cited()
    f.run("UPDATE chats SET membership_state = 'left' WHERE id = ?", f.chat)
    await f.store.chats.leftChats(f.key, { clear: true })
    await leavesNoPointer(f)
  })
})
