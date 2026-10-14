import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createUpcomingMeetingReader } from "../meetings/index.js"
import { sampleMeeting } from "../meetings/testing/index.js"
import { createTaskFromMeeting } from "../services/meeting-tasks.js"
import { openCache } from "../store/open.js"
import { openStore } from "../store/store.js"

export const preparationFixture = async (provider = "example-calendar") => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-preparation-")), "fixture.db")
  const store = await openStore({ path, now: () => 5000 })
  const db = await openCache(path)
  const key = { provider, account: "AliceExample" }
  const accountId = await store.saveAccount(key, { name: "Alice Example" })
  const otherId = await store.saveAccount({ ...key, account: "BobSample" }, { name: "Bob Sample" })
  const input = sampleMeeting()
  input.meeting.accountId = accountId
  const saved = await store.meetings.saveMeeting(input)
  if (!saved.series) throw new Error("Missing invented series")
  const reference = `meeting:${accountId}/${saved.meeting.id}`
  const project = await store.knowledge.addProject({ name: "Harbour Example", key: "HAR" })
  await store.knowledge.linkMeetingProject(key, String(saved.meeting.id), project.id)
  const fact = await store.facts.add({
    type: "decision",
    statement: "Ship the invented draft",
    by: "owner",
    subject: reference,
  })
  const task = await createTaskFromMeeting(store, key, { source: reference, kind: "promise", origin: "owner" })
  let reads = 0
  const upcoming = createUpcomingMeetingReader(key, {
    async read(meetingId) {
      reads++
      return {
        meetingId,
        kind: "single",
        timezone: "UTC",
        complete: true,
        missing: [],
        occurrences: [{ id: "invented-next", startAt: 11000, endAt: 12000, status: "scheduled", verified: true }],
      }
    },
  })
  return {
    path,
    db,
    store,
    key,
    accountId,
    otherId,
    input,
    saved,
    reference,
    project,
    fact,
    task,
    upcoming,
    reads: () => reads,
    context: {
      accountId,
      meetingId: saved.meeting.id,
      seriesId: saved.series.id,
      updatedAt: saved.meeting.updatedAt,
    },
    request: { after: 10000, until: 20000, historyAfter: 0 },
    async close() {
      db.close()
      await store.close()
    },
  }
}
