import { afterEach, describe, expect, it, vi } from "vitest"
import { preparationFixture } from "../testing/meeting-preparation.js"
import { meetingPreparationKnowledgeOver } from "./sqlite/meeting-preparation-knowledge.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})
const fixture = async () => {
  const f = await preparationFixture()
  handles.push(f)
  const context = await f.store.meetings.preparationContext(f.context)
  const person = context.participants.items[0]?.personUid
  if (!person) throw new Error("Missing invented person link")
  const add = (statement: string, subject = `project:${f.project.id}`, project?: string) =>
    f.store.facts.add({ type: "fact", statement, subject, project, by: "owner" })
  const personFact = await add("Prefers written examples", `person:${person}`)
  const projectFact = await add("Launch is in November")
  const dual = await add("Will review the launch", `person:${person}`, f.project.ref)
  const request = {
    accountId: f.accountId,
    seriesId: f.context.seriesId,
    anchorIds: [f.context.meetingId],
    after: 0,
    before: 10000,
  }
  return { ...f, person, add, personFact, projectFact, dual, request }
}

describe("accepted knowledge for meeting preparation", () => {
  it("returns cited global person/project facts once through current explicit links, without writes", async () => {
    const f = await fixture()
    const snapshot = () => f.db.prepare("SELECT * FROM facts ORDER BY id").all()
    const before = snapshot()
    const page = await f.store.meetings.preparationKnowledge(f.request)
    expect(page.hasMore).toBe(false)
    expect(page.items.map((fact) => [fact.ref, fact.sharedPerson, fact.sharedProject])).toEqual([
      [f.dual.ref, true, true],
      [f.projectFact.ref, false, true],
      [f.personFact.ref, true, false],
    ])
    expect(page.items[0]).toMatchObject({ subject: `person:${f.person}`, project: f.project.ref, updatedAt: 5000 })
    expect(page.items.map((fact) => fact.ref)).not.toContain(f.fact.ref)
    expect(snapshot()).toEqual(before)
  })

  it("keeps lookahead and deduplicates repeated anchors", async () => {
    const f = await fixture()
    const page = await f.store.meetings.preparationKnowledge({
      ...f.request,
      anchorIds: [f.context.meetingId, f.context.meetingId],
      limit: 1,
    })
    expect(page.items.map((fact) => fact.ref)).toEqual([f.dual.ref])
    expect(page.hasMore).toBe(true)
  })

  it("does not use proposed, superseded, reversed, deleted or future facts", async () => {
    const f = await fixture()
    for (const status of ["proposed", "superseded", "reversed"]) {
      const fact = await f.add(status)
      f.db.prepare("UPDATE facts SET status=? WHERE id=?").run(status, Number(fact.id))
    }
    const deleted = await f.add("Deleted")
    f.db.prepare("UPDATE facts SET deleted_at=5000 WHERE id=?").run(Number(deleted.id))
    const future = await f.add("Not recorded yet")
    f.db.prepare("UPDATE facts SET updated_at=10000 WHERE id=?").run(Number(future.id))
    expect((await f.store.meetings.preparationKnowledge(f.request)).items).toHaveLength(3)
  })

  it("rechecks person/project links and excludes proposals and deleted/scoped projects", async () => {
    const f = await fixture()
    f.db.prepare("DELETE FROM identity_links").run()
    expect((await f.store.meetings.preparationKnowledge(f.request)).items.map((fact) => fact.ref)).toEqual([
      f.dual.ref,
      f.projectFact.ref,
    ])
    f.db.prepare("UPDATE links SET confirmed=0 WHERE from_type='meeting'").run()
    expect((await f.store.meetings.preparationKnowledge(f.request)).items).toEqual([])
    f.db.prepare("UPDATE links SET confirmed=1 WHERE from_type='meeting'").run()
    for (const update of ["deleted_at=5000", `account_id=${f.otherId}`]) {
      f.db.prepare(`UPDATE projects SET ${update} WHERE id=?`).run(Number(f.project.id))
      expect((await f.store.meetings.preparationKnowledge(f.request)).items).toEqual([])
      f.db.prepare("UPDATE projects SET deleted_at=NULL,account_id=NULL WHERE id=?").run(Number(f.project.id))
    }
  })

  it("does not expose foreign scoped subjects even when the fact also has a known project", async () => {
    const f = await fixture()
    const foreign = await f.store.knowledge.addProject({ name: "Other account", key: "OTH" })
    await f.add("Foreign project subject", foreign.ref, f.project.ref)
    f.db.prepare("UPDATE projects SET account_id=? WHERE id=?").run(f.otherId, Number(foreign.id))
    await f.store.facts.add({
      type: "fact",
      statement: "Account-specific meeting subject",
      subject: f.reference,
      project: f.project.ref,
      by: "owner",
    })
    expect((await f.store.meetings.preparationKnowledge(f.request)).items).toHaveLength(3)
  })

  it("does not cross an account, series, date window or deleted anchor", async () => {
    const f = await fixture()
    for (const patch of [{ accountId: f.otherId }, { seriesId: 9999 }, { after: 9999 }, { anchorIds: [] }])
      expect((await f.store.meetings.preparationKnowledge({ ...f.request, ...patch })).items).toEqual([])
    f.db.prepare("UPDATE meetings SET deleted_at=5000 WHERE id=?").run(f.context.meetingId)
    expect((await f.store.meetings.preparationKnowledge(f.request)).items).toEqual([])
  })

  it("probes UTF-8 lookahead text before materializing any fact strings", async () => {
    const f = await fixture()
    f.db.prepare("UPDATE facts SET statement=? WHERE id=?").run("я".repeat(2000), Number(f.projectFact.id))
    const database = {
      ...f.db,
      exec: f.db.exec.bind(f.db),
      prepare: vi.fn(f.db.prepare.bind(f.db)),
    }
    const reader = meetingPreparationKnowledgeOver({ database })
    await expect(reader.preparationKnowledge({ ...f.request, limit: 1, maxReadBytes: 500 })).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(database.prepare).toHaveBeenCalledTimes(1)
  })

  it("refuses unknown fields and cancellation without querying", async () => {
    const f = await fixture()
    await expect(
      f.store.meetings.preparationKnowledge({ ...f.request, extra: true } as typeof f.request),
    ).rejects.toMatchObject({
      code: "validation_error",
    })
    const controller = new AbortController()
    controller.abort(new Error("Stopped"))
    await expect(f.store.meetings.preparationKnowledge({ ...f.request, signal: controller.signal })).rejects.toThrow(
      "Stopped",
    )
  })
})
