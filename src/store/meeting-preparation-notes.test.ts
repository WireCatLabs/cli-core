import { afterEach, describe, expect, it, vi } from "vitest"
import { preparationFixture } from "../testing/meeting-preparation.js"
import { meetingPreparationNotesOver } from "./sqlite/meeting-preparation-notes.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})
const fixture = async () => {
  const f = await preparationFixture()
  handles.push(f)
  const context = await f.store.meetings.preparationContext(f.context)
  const person = `person:${context.participants.items[0]?.personUid}`
  const first = await f.store.notes.addNote({ text: "Bring written examples", about: [person] })
  const second = await f.store.notes.addNote({
    title: "Launch",
    text: "Review the checklist",
    about: [f.project.ref, person],
  })
  const request = {
    accountId: f.accountId,
    seriesId: f.context.seriesId,
    anchorIds: [f.context.meetingId],
    after: 0,
    before: 10000,
  }
  return { ...f, person, first, second, request }
}

describe("bounded notes for meeting preparation", () => {
  it("reads owner notes and annotations once through direct and confirmed additional subjects without writes", async () => {
    const f = await fixture()
    const annotation = await f.store.knowledge.addAnnotation(
      null,
      { type: "project", id: f.project.id },
      "Check milestones",
    )
    const snapshot = () => f.db.prepare("SELECT * FROM notes ORDER BY id").all()
    const before = snapshot()
    const page = await f.store.meetings.preparationNotes(f.request)
    expect(page).toMatchObject({
      hasMore: false,
      items: [
        { ref: `note:${annotation.id}`, title: null, text: "Check milestones", person: null, project: f.project.ref },
        { ref: f.second.ref, title: "Launch", person: f.person, project: f.project.ref, revision: 1, updatedAt: 5000 },
        { ref: f.first.ref, person: f.person, project: null },
      ],
    })
    expect(snapshot()).toEqual(before)
    const edited = await f.store.notes.editNote(f.first.id, "Bring two written examples", 1)
    expect((await f.store.meetings.preparationNotes(f.request)).items.at(-1)).toMatchObject({
      ref: edited.ref,
      revision: 2,
      text: edited.text,
    })
  })

  it("deduplicates anchors and associations and reports independent lookahead", async () => {
    const f = await fixture()
    expect(
      await f.store.meetings.preparationNotes({
        ...f.request,
        anchorIds: [...f.request.anchorIds, ...f.request.anchorIds],
        limit: 1,
      }),
    ).toMatchObject({ items: [{ ref: f.second.ref }], hasMore: true })
  })

  it("excludes deleted, future, bot-authored, account-scoped and unrelated records", async () => {
    const f = await fixture()
    for (const patch of [
      "deleted_at=5000",
      "updated_at=10001",
      "author_type='bot',author_id=1",
      `notable_type='meeting',notable_id=${f.context.meetingId}`,
    ]) {
      f.db.prepare(`UPDATE notes SET ${patch} WHERE id=?`).run(Number(f.second.id))
      expect((await f.store.meetings.preparationNotes(f.request)).items.map((n) => n.ref)).toEqual([f.first.ref])
      f.db
        .prepare(
          "UPDATE notes SET deleted_at=NULL,updated_at=5000,author_type='person',author_id=(SELECT id FROM persons WHERE owner=1),notable_type='project',notable_id=? WHERE id=?",
        )
        .run(Number(f.project.id), Number(f.second.id))
    }
    await f.store.notes.addNote({ text: "Unrelated owner note" })
    await f.store.notes.addNote({ text: "Meeting-specific", about: [f.reference, f.project.ref] })
    f.db.prepare("UPDATE notes SET updated_at=10000 WHERE id=?").run(Number(f.first.id))
    expect((await f.store.meetings.preparationNotes(f.request)).items.map((n) => n.ref)).toEqual([
      f.first.ref,
      f.second.ref,
    ])
  })

  it("rechecks people, project scopes and confirmations instead of matching names", async () => {
    const f = await fixture()
    f.db.prepare("UPDATE links SET confirmed=0 WHERE from_type='note'").run()
    expect((await f.store.meetings.preparationNotes(f.request)).items[0]).toMatchObject({
      person: null,
      project: f.project.ref,
    })
    f.db.prepare("DELETE FROM identity_links").run()
    expect((await f.store.meetings.preparationNotes(f.request)).items.map((n) => n.ref)).toEqual([f.second.ref])
    f.db.prepare("UPDATE links SET confirmed=0 WHERE from_type='meeting'").run()
    expect((await f.store.meetings.preparationNotes(f.request)).items).toEqual([])
    f.db.prepare("UPDATE links SET confirmed=1").run()
    for (const update of ["deleted_at=5000", `account_id=${f.otherId}`]) {
      f.db.prepare(`UPDATE projects SET ${update} WHERE id=?`).run(Number(f.project.id))
      expect((await f.store.meetings.preparationNotes(f.request)).items).toEqual([])
      f.db.prepare("UPDATE projects SET deleted_at=NULL,account_id=NULL WHERE id=?").run(Number(f.project.id))
    }
  })

  it("does not cross accounts, series or history bounds and refuses missing/deleted anchors", async () => {
    const f = await fixture()
    for (const patch of [{ accountId: f.otherId }, { seriesId: 9999 }, { after: 9999 }, { anchorIds: [] }])
      expect((await f.store.meetings.preparationNotes({ ...f.request, ...patch })).items).toEqual([])
    f.db.prepare("UPDATE meeting_series SET deleted_at=5000 WHERE id=?").run(f.context.seriesId)
    expect((await f.store.meetings.preparationNotes(f.request)).items).toEqual([])
  })

  it("checks UTF-8 titles and bodies including lookahead before hydration", async () => {
    const f = await fixture()
    for (const column of ["title", "body"]) {
      f.db.prepare(`UPDATE notes SET ${column}=? WHERE id=?`).run("界".repeat(1000), Number(f.first.id))
      const database = { ...f.db, exec: f.db.exec.bind(f.db), prepare: vi.fn(f.db.prepare.bind(f.db)) }
      await expect(
        meetingPreparationNotesOver({ database }).preparationNotes({ ...f.request, limit: 1, maxReadBytes: 500 }),
      ).rejects.toMatchObject({ code: "validation_error" })
      expect(database.prepare).toHaveBeenCalledTimes(1)
    }
  })

  it("refuses unknown fields and cancellation before querying", async () => {
    const f = await fixture()
    const database = { ...f.db, exec: f.db.exec.bind(f.db), prepare: vi.fn(f.db.prepare.bind(f.db)) }
    const reader = meetingPreparationNotesOver({ database })
    await expect(reader.preparationNotes({ ...f.request, extra: true } as typeof f.request)).rejects.toMatchObject({
      code: "validation_error",
    })
    const controller = new AbortController()
    controller.abort(new Error("Stopped"))
    await expect(reader.preparationNotes({ ...f.request, signal: controller.signal })).rejects.toThrow("Stopped")
    expect(database.prepare).not.toHaveBeenCalled()
  })
})
