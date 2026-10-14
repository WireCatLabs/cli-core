import { afterEach, describe, expect, it, vi } from "vitest"
import { type MeetingPreparationContextRequest, validateMeetingPreparationContext } from "../meetings/index.js"
import { createTaskFromMeeting } from "../services/meeting-tasks.js"
import { preparationFixture } from "../testing/meeting-preparation.js"
import { openCache } from "./open.js"
import { meetingPreparationContextOver } from "./sqlite/meeting-preparation-context.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})
const fixture = async () => {
  const fixture = await preparationFixture()
  handles.push(fixture)
  return fixture
}

describe("bounded preparation context", () => {
  it("keeps independent lookahead coverage for every context category", async () => {
    const f = await fixture()
    const participant = f.input.participants[0]
    await f.store.meetings.saveMeeting({
      ...f.input,
      participants: [
        participant,
        {
          ...participant,
          displayName: "Bob Sample",
          identity: { ...participant.identity, externalId: "bob-sample", associatePerson: false },
        },
      ],
    })
    const project = await f.store.knowledge.addProject({ name: "Second invented project", key: "SAMP" })
    await f.store.knowledge.linkMeetingProject(f.key, String(f.context.meetingId), project.id)
    await f.store.facts.add({ type: "promise", statement: "Send the example draft", by: "owner", subject: f.reference })
    const transcript = f.saved.transcripts[0]
    if (!transcript) throw new Error("Missing invented transcript")
    await createTaskFromMeeting(f.store, f.key, {
      source: `${f.reference}/${transcript.transcript.id}/0`,
      kind: "request",
      origin: "owner",
    })
    const result = await f.store.meetings.preparationContext({ ...f.context, limit: 1 })
    for (const page of Object.values(result)) {
      expect(page.items).toHaveLength(1)
      expect(page.hasMore).toBe(true)
    }
  })

  it.each(["participants", "projects", "facts", "tasks"] as const)(
    "bounds UTF-8 %s text before hydration",
    async (category) => {
      const f = await fixture()
      const updates = {
        participants: "UPDATE meeting_participants SET display_name=?",
        projects: "UPDATE projects SET name=?",
        facts: "UPDATE facts SET statement=?",
        tasks: "UPDATE tasks SET title=?",
      }
      f.db.prepare(updates[category]).run("界".repeat(1000))
      await expect(f.store.meetings.preparationContext({ ...f.context, maxReadBytes: 500 })).rejects.toMatchObject({
        code: "validation_error",
      })
    },
  )
  it("returns observed participants, stored person links, confirmed membership, accepted facts and sourced tasks", async () => {
    const f = await fixture()
    const result = await f.store.meetings.preparationContext(f.context)
    expect(result.participants.items).toMatchObject([
      { id: f.saved.participants[0]?.id, displayName: "Alice Example", personUid: expect.any(String) },
    ])
    expect(result.projects.items).toMatchObject([{ ref: f.project.ref, key: "HAR" }])
    expect(result.facts.items).toMatchObject([
      { ref: f.fact.ref, type: "decision", statement: "Ship the invented draft" },
    ])
    expect(result.tasks.items).toMatchObject([{ ref: `task:${f.task.task.id}`, source: f.reference }])
    for (const page of Object.values(result)) expect(page.hasMore).toBe(false)
    const proposed = await f.store.knowledge.addProject({ name: "Sample proposed", key: "PROP" })
    await f.store.knowledge.linkMeetingProject(f.key, String(f.saved.meeting.id), proposed.id, { by: "agent" })
    await f.store.facts.add({
      type: "decision",
      statement: "Unreviewed",
      by: { bot: "invented-agent" },
      subject: f.reference,
    })
    await f.store.facts.add({ type: "fact", statement: "Project-wide context", by: "owner", subject: f.project.ref })
    expect(await f.store.meetings.preparationContext(f.context)).toEqual(result)
  })

  it("refuses foreign accounts, changed series/revisions and deleted parents", async () => {
    const f = await fixture()
    for (const patch of [{ accountId: f.otherId }, { seriesId: 9999 }, { updatedAt: 9999 }])
      await expect(f.store.meetings.preparationContext({ ...f.context, ...patch })).rejects.toMatchObject({
        code: "not_found",
      })
    f.db.prepare("UPDATE meeting_series SET deleted_at=5000 WHERE id=?").run(f.context.seriesId)
    await expect(f.store.meetings.preparationContext(f.context)).rejects.toMatchObject({ code: "not_found" })
    f.db.prepare("UPDATE meeting_series SET deleted_at=NULL WHERE id=?").run(f.context.seriesId)
    f.db.prepare("UPDATE meetings SET deleted_at=5000 WHERE id=?").run(f.context.meetingId)
    await expect(f.store.meetings.preparationContext(f.context)).rejects.toMatchObject({ code: "not_found" })
  })

  it("bounds every category and rejects oversized UTF-8 lookahead before hydrating any text", async () => {
    const f = await fixture()
    await f.store.facts.add({ type: "statement", statement: "界".repeat(150), by: "owner", subject: f.reference })
    const reader = meetingPreparationContextOver({ database: f.db })
    const result = await reader.preparationContext({ ...f.context, limit: 1 })
    expect(result.facts).toMatchObject({ items: [expect.any(Object)], hasMore: true })
    const spy = vi.spyOn(f.db, "prepare")
    await expect(reader.preparationContext({ ...f.context, limit: 1, maxReadBytes: 200 })).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(spy.mock.calls.some(([sql]) => sql.startsWith("SELECT p.id") || sql.startsWith("SELECT f.id"))).toBe(false)
  })

  it("excludes deleted records, unlinked names and tasks with a different source account", async () => {
    const f = await fixture()
    f.db.prepare("DELETE FROM identity_links WHERE identity_id=?").run(f.saved.participants[0]?.identityId ?? 0)
    f.db
      .prepare("UPDATE tasks SET source_locator=? WHERE source_group=?")
      .run(`meeting:${f.otherId}/${f.context.meetingId}`, f.reference)
    f.db.prepare("UPDATE facts SET deleted_at=5000 WHERE id=?").run(Number(f.fact.id))
    f.db.prepare("UPDATE projects SET deleted_at=5000 WHERE id=?").run(Number(f.project.id))
    const result = await f.store.meetings.preparationContext(f.context)
    expect(result.participants.items[0]?.personUid).toBeNull()
    expect(result.projects.items).toEqual([])
    expect(result.facts.items).toEqual([])
    expect(result.tasks.items).toEqual([])
  })

  it("retains one snapshot during concurrent UTF-8 growth and leaves write queues untouched", async () => {
    const f = await fixture()
    const writer = await openCache(f.path)
    handles.push(writer)
    const prepare = f.db.prepare.bind(f.db)
    let changed = false
    const database = {
      ...f.db,
      prepare(sql: string) {
        const statement = prepare(sql)
        if (!sql.includes("sum(read_bytes)")) return statement
        return {
          ...statement,
          get(...params: Parameters<typeof statement.get>) {
            const result = statement.get(...params)
            if (!changed) {
              changed = true
              writer.prepare("UPDATE facts SET statement=? WHERE id=?").run("界".repeat(1000), Number(f.fact.id))
            }
            return result
          },
        }
      },
    }
    const before = f.db.prepare("SELECT * FROM meeting_index_pending").all()
    const reader = meetingPreparationContextOver({ database })
    expect((await reader.preparationContext({ ...f.context, maxReadBytes: 500 })).facts.items[0]?.statement).toBe(
      f.fact.statement,
    )
    expect(changed).toBe(true)
    await expect(reader.preparationContext({ ...f.context, maxReadBytes: 500 })).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(f.db.prepare("SELECT * FROM meeting_index_pending").all()).toEqual(before)
  })

  it("rejects late cancellation and releases its transaction", async () => {
    const f = await fixture()
    const controller = new AbortController()
    const prepare = f.db.prepare.bind(f.db)
    const database = {
      ...f.db,
      prepare(sql: string) {
        const statement = prepare(sql)
        if (!sql.startsWith("SELECT t.id")) return statement
        return {
          ...statement,
          all(...params: Parameters<typeof statement.all>) {
            const rows = statement.all(...params)
            controller.abort(new Error("Invented cancellation"))
            return rows
          },
        }
      },
    }
    await expect(
      meetingPreparationContextOver({ database }).preparationContext({ ...f.context, signal: controller.signal }),
    ).rejects.toThrow("Invented cancellation")
    expect((await f.store.meetings.preparationContext(f.context)).facts.items).toHaveLength(1)
  })
})

describe("context validation", () => {
  it.each([
    { accountId: 0 },
    { meetingId: -1 },
    { seriesId: 0.5 },
    { updatedAt: Infinity },
    { limit: null },
    { limit: 101 },
    { maxReadBytes: null },
    { maxReadBytes: 0 },
    { maxReadBytes: 4194305 },
    { signal: {} },
    { unexpected: true },
  ])("refuses %j before SQL", async (patch) => {
    const f = await fixture()
    const spy = vi.spyOn(f.db, "prepare")
    await expect(
      meetingPreparationContextOver({ database: f.db }).preparationContext({
        ...f.context,
        ...patch,
      } as MeetingPreparationContextRequest),
    ).rejects.toMatchObject({ code: "validation_error" })
    expect(spy).not.toHaveBeenCalled()
  })
  it("requires an input and refuses an already cancelled read", () => {
    expect(() => validateMeetingPreparationContext(null as unknown as MeetingPreparationContextRequest)).toThrow(
      "required",
    )
    expect(() =>
      validateMeetingPreparationContext({
        accountId: 1,
        meetingId: 1,
        seriesId: 1,
        updatedAt: 1,
        signal: AbortSignal.abort(new Error("Invented abort")),
      }),
    ).toThrow("Invented abort")
  })
})
