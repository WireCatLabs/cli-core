import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { sampleMeeting } from "../meetings/testing/index.js"
import { openCache } from "./open.js"
import { type MessageStore, openStore } from "./store.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
const key = { provider: "example", account: "AliceExample" }
const other = { provider: "example", account: "BobSample" }
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-project-test-")), "fixture.db")
  const store = await openStore({ path, now: () => 3000 })
  opened.push(store)
  const accountId = await store.saveAccount(key, { name: "Alice Example" })
  await store.saveAccount(other, { name: "Bob Sample" })
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  const saved = await store.meetings.saveMeeting(input)
  const project = await store.knowledge.addProject({ name: "Harbour Example", key: "HAR" })
  return { store, path, meeting: String(saved.meeting.id), project: project.id }
}
it("keeps agent membership proposed until an owner reviews its fingerprint, and replays without duplicates", async () => {
  const { store, path, meeting, project } = await fixture()
  const proposed = await store.knowledge.linkMeetingProject(key, meeting, project, {
    by: "agent",
    provenance: "Title candidate, awaiting review",
  })
  expect(proposed).toMatchObject({ changed: true, link: { project: `project:${project}`, confirmed: false } })
  expect(await store.knowledge.linkMeetingProject(key, meeting, project, { by: "agent" })).toMatchObject({
    changed: false,
  })
  await expect(store.knowledge.linkMeetingProject(key, meeting, project)).rejects.toMatchObject({
    code: "validation_error",
  })
  expect((await store.knowledge.meetingProjects(key, { confirmed: true })).items).toEqual([])
  const accepted = await store.knowledge.linkMeetingProject(key, meeting, project, {
    expectedFingerprint: proposed.link.fingerprint,
  })
  expect(accepted).toMatchObject({ changed: true, link: { confirmed: true } })
  await expect(
    store.knowledge.linkMeetingProject(key, meeting, project, { expectedFingerprint: proposed.link.fingerprint }),
  ).rejects.toMatchObject({ details: { reason: "stale_meeting_project" } })
  expect(await store.knowledge.linkMeetingProject(key, meeting, project)).toMatchObject({ changed: false })
  const reopened = await openStore({ path })
  opened.push(reopened)
  expect((await reopened.knowledge.meetingProjects(key, { projectId: project, confirmed: true })).items).toEqual([
    accepted.link,
  ])
})
it("refuses foreign/deleted meetings and deleted projects without creating links", async () => {
  const { store, path, meeting, project } = await fixture()
  await expect(store.knowledge.linkMeetingProject(other, meeting, project)).rejects.toMatchObject({ code: "not_found" })
  expect((await store.knowledge.meetingProjects(other)).items).toEqual([])
  const db = await openCache(path)
  try {
    db.prepare("UPDATE projects SET deleted_at=3000 WHERE id=?").run(Number(project))
  } finally {
    db.close()
  }
  await expect(store.knowledge.linkMeetingProject(key, meeting, project)).rejects.toMatchObject({ code: "not_found" })
  expect((await store.knowledge.meetingProjects(key)).items).toEqual([])
})
it("bounds reads and validates explicit accounts, IDs, cancellation and provenance", async () => {
  const { store, meeting, project } = await fixture()
  for (const value of ["0", "-1", "1.5", "9007199254740992"])
    await expect(store.knowledge.linkMeetingProject(key, value, project)).rejects.toMatchObject({
      code: "validation_error",
    })
  await expect(store.knowledge.meetingProjects({ provider: "", account: "" })).rejects.toMatchObject({
    code: "validation_error",
  })
  await expect(store.knowledge.meetingProjects({ ...key, account: "UnknownExample" })).rejects.toMatchObject({
    code: "not_found",
  })
  await expect(store.knowledge.meetingProjects(key, { limit: 501 })).rejects.toMatchObject({ code: "validation_error" })
  await expect(
    store.knowledge.linkMeetingProject(key, meeting, project, { provenance: "x".repeat(2001) }),
  ).rejects.toMatchObject({ code: "validation_error" })
  await expect(store.knowledge.meetingProjects(key, { signal: AbortSignal.abort() })).rejects.toMatchObject({
    code: "cancelled",
  })
  await store.knowledge.linkMeetingProject(key, meeting, project)
  const second = await store.knowledge.addProject({ name: "Lighthouse Example", key: "LIGH" })
  await store.knowledge.linkMeetingProject(key, meeting, second.id)
  const page = await store.knowledge.meetingProjects(key, { limit: 1 })
  expect(page.items).toHaveLength(1)
  expect(page.hasMore).toBe(true)
  const next = await store.knowledge.meetingProjects(key, { limit: 1, offset: 1 })
  expect(next.hasMore).toBe(false)
  expect(next.items[0]?.id).not.toBe(page.items[0]?.id)
})
it("hides deleted meetings and refuses oversized stored provenance before returning it", async () => {
  const { store, path, meeting, project } = await fixture()
  const made = await store.knowledge.linkMeetingProject(key, meeting, project)
  const db = await openCache(path)
  try {
    db.prepare("UPDATE links SET evidence=? WHERE id=?").run("x".repeat(2001), Number(made.link.id))
    await expect(store.knowledge.meetingProjects(key)).rejects.toMatchObject({ code: "validation_error" })
    db.prepare("UPDATE links SET evidence=NULL WHERE id=?").run(Number(made.link.id))
    db.prepare("UPDATE meetings SET deleted_at=3000 WHERE id=?").run(Number(meeting))
    expect((await store.knowledge.meetingProjects(key)).items).toEqual([])
    await expect(store.knowledge.linkMeetingProject(key, meeting, project)).rejects.toMatchObject({ code: "not_found" })
  } finally {
    db.close()
  }
})
