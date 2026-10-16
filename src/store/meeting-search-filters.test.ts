import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { sampleEvent, sampleMeeting } from "../meetings/testing/index.js"
import { refreshMeetingIndex, searchMeetingHits } from "../services/meeting-hit-search.js"
import { openCache } from "./open.js"
import { openStore } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const item of opened.splice(0)) await item.close()
})
const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-test-filters-")), "fixture.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path }, now: () => 3000 })
  opened.push(store)
  const key = { provider: "example", account: "AliceExample" }
  const accountId = await store.accounts.saveAccount(key, { name: "Alice Example" })
  const otherId = await store.accounts.saveAccount(
    { provider: "second-example", account: "BobSample" },
    { name: "Bob Sample" },
  )
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  const first = await store.meetings.saveMeeting(input)
  const second = await store.meetings.saveMeeting({
    ...input,
    meeting: { ...input.meeting, externalId: "second-occurrence", startedAt: 2000 },
  })
  const foreign = await store.meetings.saveMeeting({ ...input, meeting: { ...input.meeting, accountId: otherId } })
  await store.meetings.indexSearch({ accountId })
  await store.meetings.indexSearch({ accountId: otherId })
  const project = await store.knowledge.addProject({ name: "Research Example", key: "RES", scope: "work" })
  await store.knowledge.addVocabularyAlias({ kind: "project", id: project.id }, "исследование")
  await store.knowledge.linkMeetingProject(key, String(first.meeting.id), project.id)
  await store.knowledge.linkMeetingProject(key, String(second.meeting.id), project.id, {
    by: "agent",
    provenance: "Invented suggestion",
  })
  await store.knowledge.addTags(key, { type: "meeting", id: String(first.meeting.id) }, ["planning"])
  const tag = (await store.knowledge.resolveVocabulary("planning", { kind: "tag" })).matches[0]
  if (!tag) throw new Error("missing fictional tag")
  await store.knowledge.addVocabularyAlias({ kind: "tag", id: tag.id }, "plan-alias")
  const db = await openCache(path)
  opened.push(db)
  const identityId = first.participants[0]?.identityId
  if (!identityId) throw new Error("missing fictional identity")
  const personId = Number(
    db.prepare("SELECT person_id FROM identity_links WHERE identity_id=?").get(identityId)?.person_id,
  )
  return { store, db, key, accountId, otherId, first, second, foreign, project, tag, identityId, personId }
}
it("combines scoped participant, person, confirmed project, label and date filters before paging", async () => {
  const f = await fixture()
  const options = {
    accountId: f.accountId,
    participantIdentityId: f.identityId,
    personId: f.personId,
    projectId: Number(f.project.id),
    tagId: Number(f.tag.id),
    since: 1000,
    until: 1000,
  }
  const first = await f.store.meetings.searchHits("example", { ...options, limit: 1 })
  expect(first.items.map((hit) => hit.meetingId)).toEqual([f.first.meeting.id])
  expect(first.hasMore).toBe(true)
  expect(first.coverage.archiveCompleteness).toBe("unknown")
  const next = await f.store.meetings.searchHits("example", { ...options, after: first.nextCursor ?? undefined })
  expect(next.items.length).toBeGreaterThan(0)
  expect(next.items.every((hit) => hit.meetingId === f.first.meeting.id)).toBe(true)
  for (const change of [
    { participantIdentityId: f.identityId + 100 },
    { personId: f.personId + 100 },
    { projectId: Number(f.project.id) + 100 },
    { tagId: Number(f.tag.id) + 100 },
  ]) {
    expect((await f.store.meetings.searchHits("example", { ...options, ...change })).items).toEqual([])
    await expect(
      f.store.meetings.searchHits("example", { ...options, ...change, after: first.nextCursor ?? undefined }),
    ).rejects.toMatchObject({ code: "validation_error" })
  }
})
it("excludes proposed membership, deleted projects and foreign meetings without guessing from text", async () => {
  const f = await fixture()
  const options = { accountId: f.accountId, projectId: Number(f.project.id) }
  expect(
    (await f.store.meetings.searchHits("example", options)).items.every((hit) => hit.meetingId === f.first.meeting.id),
  ).toBe(true)
  expect((await f.store.meetings.searchHits("example", { ...options, accountId: f.otherId })).items).toEqual([])
  f.db.prepare("UPDATE projects SET deleted_at=4000 WHERE id=?").run(Number(f.project.id))
  expect((await f.store.meetings.searchHits("example", options)).items).toEqual([])
})
it("resolves canonical names, keys and explicit aliases without changing records", async () => {
  const f = await fixture()
  for (const project of ["Research Example", "RES", "ИССЛЕДОВАНИЕ"]) {
    const result = await searchMeetingHits(f.store, "example", { accountId: f.accountId, project, tag: "plan-alias" })
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.items.every((hit) => hit.meetingId === f.first.meeting.id)).toBe(true)
    expect(result.selection).toMatchObject([
      { kind: "project", id: Number(f.project.id), by: "explicit-link" },
      { kind: "tag", id: Number(f.tag.id) },
    ])
  }
  await expect(
    searchMeetingHits(f.store, "example", { accountId: f.accountId, project: "Research Exampl" }),
  ).rejects.toMatchObject({ code: "not_found" })
  await f.store.knowledge.addProject({ name: "Research Example", key: "RES2", scope: "personal" })
  await expect(
    searchMeetingHits(f.store, "example", { accountId: f.accountId, project: "Research Example" }),
  ).rejects.toMatchObject({ code: "validation_error" })
  for (const change of [
    { project: "RES", projectId: Number(f.project.id) },
    { tag: "planning", topic: "planning" },
    { tag: "planning", tagId: Number(f.tag.id) },
  ])
    await expect(searchMeetingHits(f.store, "example", { accountId: f.accountId, ...change })).rejects.toMatchObject({
      code: "validation_error",
    })
})
it("uses topic aliases and explicit identity links without attributing anonymous transcript speech", async () => {
  const f = await fixture()
  const topic = await f.store.knowledge.createTag("budget", { kind: "topic" })
  await f.store.knowledge.addVocabularyAlias({ kind: "topic", id: String(topic.id) }, "costs")
  await f.store.knowledge.setMainTopic(f.key, { type: "meeting", id: String(f.first.meeting.id) }, "budget")
  const result = await searchMeetingHits(f.store, "example", {
    accountId: f.accountId,
    topic: "costs",
    personId: f.personId,
  })
  expect(result.items.length).toBeGreaterThan(0)
  f.db.prepare("DELETE FROM identity_links WHERE identity_id=?").run(f.identityId)
  expect((await searchMeetingHits(f.store, "example", { accountId: f.accountId, personId: f.personId })).items).toEqual(
    [],
  )
  expect(
    (await searchMeetingHits(f.store, "example", { accountId: f.accountId, participantIdentityId: f.identityId })).items
      .length,
  ).toBeGreaterThan(0)
  for (const field of ["participantIdentityId", "personId", "projectId", "tagId"])
    await expect(f.store.meetings.searchHits("example", { accountId: f.accountId, [field]: 0 })).rejects.toMatchObject({
      code: "validation_error",
    })
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(
    searchMeetingHits(f.store, "example", { accountId: f.accountId, signal: cancelled.signal }),
  ).rejects.toThrow()
})

it("uses the same alias and membership search for a second provider without a provider branch", async () => {
  const f = await fixture()
  await f.store.knowledge.linkMeetingProject(
    { provider: "second-example", account: "BobSample" },
    String(f.foreign.meeting.id),
    f.project.id,
  )
  const result = await searchMeetingHits(f.store, "example", {
    accountId: f.otherId,
    project: "исследование",
    participantIdentityId: f.foreign.participants[0]?.identityId,
  })
  expect(result.items.length).toBeGreaterThan(0)
  expect(result.items.every((hit) => hit.meetingId === f.foreign.meeting.id)).toBe(true)
})

it("filters by a linked event and by a meeting series, and binds the cursor to them", async () => {
  const f = await fixture()
  const event = await f.store.meetings.createEvent(sampleEvent(), 3000)
  await f.store.meetings.linkMeeting(f.second.meeting.id, event.id, 4000, "owner")
  const input = sampleMeeting()
  input.meeting.accountId = f.accountId
  input.meeting.externalId = "third-occurrence"
  if (input.meeting.series) input.meeting.series.externalId = "other-series"
  const third = await f.store.meetings.saveMeeting(input)
  const meetingsOf = async (filter: { eventId?: number; meetingSeriesId?: number }) => [
    ...new Set(
      (await searchMeetingHits(f.store, "example", { accountId: f.accountId, ...filter })).items.map(
        (hit) => hit.meetingId,
      ),
    ),
  ]
  expect(await meetingsOf({ eventId: event.id })).toEqual([f.second.meeting.id])
  const series = third.series?.id
  if (!series || series === f.first.series?.id) throw new Error("missing fictional series")
  expect(await meetingsOf({ meetingSeriesId: series })).toEqual([third.meeting.id])
  const page = await f.store.meetings.searchHits("example", { accountId: f.accountId, limit: 1 })
  await expect(
    f.store.meetings.searchHits("example", { accountId: f.accountId, eventId: event.id, after: page.nextCursor ?? "" }),
  ).rejects.toMatchObject({ code: "validation_error" })
})
it("indexes what was saved since the last search before it reads", async () => {
  const f = await fixture()
  const input = sampleMeeting()
  input.transcripts[0].rows[0].text = "Invented zeppelin agenda"
  const added = await f.store.meetings.saveMeeting({
    ...input,
    meeting: { ...input.meeting, accountId: f.accountId, externalId: "unindexed-occurrence" },
  })
  expect((await f.store.meetings.searchHits("zeppelin", { accountId: f.accountId })).items).toEqual([])
  const result = await searchMeetingHits(f.store, "zeppelin", { accountId: f.accountId })
  expect(result.items.map((hit) => hit.meetingId)).toEqual([added.meeting.id])
  expect(result.coverage.indexing).toBe("ready")
})
it("stops refreshing when a batch makes no progress", async () => {
  const indexSearch = vi.fn(async () => ({ indexed: 1, remaining: 2 }))
  await refreshMeetingIndex({ indexSearch }, 1)
  expect(indexSearch).toHaveBeenCalledTimes(2)
})
