import { CliError, projectFields } from "@wirecat/cli-base"
import { afterEach, describe, expect, it, vi } from "vitest"
import { meetingPreparationAnswer } from "../cli/meeting-preparation-answer.js"
import type { MeetingPreparationNote } from "../meetings/index.js"
import { preparationFixture } from "../testing/meeting-preparation.js"
import { createMeetingPreparationService } from "./meeting-preparation.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})
const fixture = async (provider = "example-calendar") => {
  const f = await preparationFixture(provider)
  handles.push(f)
  const note = await f.store.notes.addNote({ text: "Bring the launch checklist", about: [f.project.ref] })
  const ports = { meetings: f.store.meetings, upcoming: f.upcoming }
  const service = createMeetingPreparationService(f.key, f.accountId, ports)
  const host = (preparationNotes: typeof f.store.meetings.preparationNotes | undefined) =>
    createMeetingPreparationService(f.key, f.accountId, { ...ports, meetings: { ...ports.meetings, preparationNotes } })
  return { ...f, note, service, host }
}

describe("owner note context in meeting preparation", () => {
  it.each(["example-calendar", "another-calendar"])(
    "uses shared notes for %s with revision, citations and projection coverage",
    async (provider) => {
      const f = await fixture(provider)
      const result = await f.service.prepare("example-series", f.request)
      expect(result.notes).toMatchObject({
        anchors: [f.reference],
        items: [{ ref: f.note.ref, revision: 1, project: f.project.ref }],
        selection: "owner-written-global-person/project-notes",
        coverage: {
          hasMore: false,
          outputLimited: false,
          sourceEvidence: "not-revalidated",
          otherSources: "not-queried",
        },
      })
      const answer = meetingPreparationAnswer(result)
      expect(answer.item.notes?.items[0]).toMatchObject({ ref: f.note.ref, updated_at: "1970-01-01T00:00:05.000Z" })
      expect(projectFields(answer.item, ["notes.items.ref"])).toMatchObject({
        notes: {
          items: [{ ref: f.note.ref }],
          coverage: { has_more: false, source_evidence: "not-revalidated", other_sources: "not-queried" },
        },
      })
      expect(result.coverage.unqueried).toContain("project-nonmeeting-context")
    },
  )

  it("supports hosts without notes, and avoids querying without included anchors", async () => {
    const f = await fixture()
    expect((await f.host(undefined).prepare("example-series", f.request)).notes).toBeUndefined()
    const read = vi.fn(f.store.meetings.preparationNotes)
    expect((await f.host(read).prepare("not-stored", f.request)).notes).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })

  it("reports row limits and preserves meeting evidence under SDK and public byte truncation", async () => {
    const f = await fixture()
    await f.store.notes.addNote({ text: "Second", about: [f.project.ref] })
    const bounded = await f.service.prepare("example-series", { ...f.request, contextLimit: 1 })
    expect(bounded.notes?.coverage.hasMore).toBe(true)
    f.db.prepare("UPDATE notes SET body=?").run("界".repeat(2000))
    const result = await f.service.prepare("example-series", { ...f.request, bytes: 8192 })
    expect(result.items).toHaveLength(1)
    expect(result.notes).toMatchObject({ items: [], coverage: { outputLimited: true } })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192)
    const full = await f.service.prepare("example-series", f.request)
    const original = meetingPreparationAnswer(full)
    full.limits.bytes = Buffer.byteLength(JSON.stringify(original.item)) - 500
    const trimmed = meetingPreparationAnswer(full)
    expect(trimmed.item.notes?.items.length).toBeLessThan(2)
    expect(trimmed.item.meetings).toHaveLength(1)
    expect(trimmed.item.coverage.output_limited).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(trimmed.item))).toBeLessThanOrEqual(full.limits.bytes)
  })

  it("refuses invalid, duplicate and oversized host notes", async () => {
    const f = await fixture()
    const valid: MeetingPreparationNote = {
      ref: f.note.ref,
      title: null,
      text: "Checklist",
      revision: 1,
      updatedAt: 5000,
      person: null,
      project: f.project.ref,
    }
    for (const patch of [
      { ref: "fact:1" },
      { title: 3 },
      { text: "" },
      { text: "界".repeat(100000) },
      { revision: 0 },
      { updatedAt: 10001 },
      { person: "meeting:1/1" },
      { project: null },
    ]) {
      await expect(
        f
          .host(async () => ({ items: [{ ...valid, ...patch } as MeetingPreparationNote], hasMore: false }))
          .prepare("example-series", f.request),
      ).rejects.toMatchObject({ code: "invalid_response" })
    }
    for (const items of [[valid, valid], Array.from({ length: 21 }, () => valid)])
      await expect(
        f.host(async () => ({ items, hasMore: false })).prepare("example-series", f.request),
      ).rejects.toMatchObject({ code: "invalid_response" })
  })

  it("propagates read failures and cancellation", async () => {
    const f = await fixture()
    await expect(
      f
        .host(async () => {
          throw new CliError("validation_error", "Invented overflow")
        })
        .prepare("example-series", f.request),
    ).rejects.toMatchObject({ code: "validation_error" })
    const controller = new AbortController()
    await expect(
      f
        .host(async () => {
          controller.abort(new CliError("timeout", "Invented deadline"))
          return { items: [], hasMore: false }
        })
        .prepare("example-series", { ...f.request, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "timeout" })
  })
})
