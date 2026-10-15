import { CliError, projectFields } from "@wirecat/cli-base"
import { afterEach, describe, expect, it, vi } from "vitest"
import { meetingPreparationAnswer } from "../cli/meeting-preparation-answer.js"
import type { MeetingPreparationFact } from "../meetings/index.js"
import { preparationFixture } from "../testing/meeting-preparation.js"
import { createMeetingPreparationService } from "./meeting-preparation.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})
const fixture = async (provider?: string) => {
  const f = await preparationFixture(provider)
  handles.push(f)
  const fact = await f.store.facts.add({
    type: "decision",
    statement: "Use the written launch checklist",
    subject: f.project.ref,
    by: "owner",
  })
  const ports = { meetings: f.store.meetings, upcoming: f.upcoming }
  return { ...f, fact, ports, service: createMeetingPreparationService(f.key, f.accountId, ports) }
}

describe("meeting knowledge preparation", () => {
  it.each(["example-calendar", "another-calendar"])(
    "includes accepted knowledge for %s in SDK and envelope",
    async (provider) => {
      const f = await fixture(provider)
      const result = await f.service.prepare("example-series", f.request)
      expect(result.knowledge).toMatchObject({
        anchors: [f.reference],
        items: [{ ref: f.fact.ref, subject: f.project.ref, sharedProject: true, sharedPerson: false }],
        selection: "accepted-global-person/project-facts",
        coverage: {
          hasMore: false,
          outputLimited: false,
          factEvidence: "not-revalidated",
          otherSources: "not-queried",
        },
      })
      const answer = meetingPreparationAnswer(result)
      expect(answer.item.knowledge?.items[0]).toMatchObject({
        ref: f.fact.ref,
        shared_project: true,
        updated_at: "1970-01-01T00:00:05.000Z",
      })
      expect(JSON.stringify(answer)).not.toContain("updatedAt")
      expect(projectFields(answer.item, ["knowledge.items.ref"])).toMatchObject({
        knowledge: {
          items: [{ ref: f.fact.ref }],
          coverage: {
            has_more: false,
            output_limited: false,
            fact_evidence: "not-revalidated",
            other_sources: "not-queried",
          },
        },
      })
      expect(result.coverage.unqueried).toContain("project-alias-candidates")
    },
  )

  it("keeps a custom host without the optional port compatible and visibly unqueried", async () => {
    const f = await fixture()
    const service = createMeetingPreparationService(f.key, f.accountId, {
      ...f.ports,
      meetings: { ...f.store.meetings, preparationKnowledge: undefined },
    })
    const result = await service.prepare("example-series", f.request)
    expect(result.knowledge).toBeUndefined()
    expect(meetingPreparationAnswer(result).item.knowledge).toBeUndefined()
    expect(result.coverage.unqueried).toContain("project-nonmeeting-context")
  })

  it("rejects duplicate, oversized and invalid custom pages before rendering", async () => {
    const f = await fixture()
    const page = await f.store.meetings.preparationKnowledge({
      accountId: f.accountId,
      seriesId: f.context.seriesId,
      anchorIds: [f.context.meetingId],
      after: 0,
      before: 10000,
    })
    const fact = page.items[0]
    if (!fact) throw new Error("Missing invented fact")
    const preparationKnowledge = vi.fn(async () => page)
    const service = createMeetingPreparationService(f.key, f.accountId, {
      ...f.ports,
      meetings: { ...f.store.meetings, preparationKnowledge },
    })
    for (const items of [
      [fact, fact],
      Array.from({ length: 21 }, () => fact),
      [{ ...fact, statement: "界".repeat(100000) }],
    ]) {
      preparationKnowledge.mockResolvedValueOnce({ ...page, items })
      await expect(service.prepare("example-series", f.request)).rejects.toMatchObject({ code: "invalid_response" })
    }
  })

  it("keeps meeting evidence while reporting truncated knowledge in both SDK and public budgets", async () => {
    const f = await fixture()
    f.db.prepare("UPDATE facts SET statement=? WHERE id=?").run("界".repeat(2000), Number(f.fact.id))
    const result = await f.service.prepare("example-series", { ...f.request, bytes: 8192 })
    expect(result.items).toHaveLength(1)
    expect(result.knowledge).toMatchObject({ items: [], coverage: { outputLimited: true } })
    expect(result.coverage.outputLimited).toBe(true)
    const answer = meetingPreparationAnswer(result)
    expect(answer.item.meetings).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192)
    expect(Buffer.byteLength(JSON.stringify(answer.item))).toBeLessThanOrEqual(8192)
  })

  it("uses one optional read with included anchors and independent lookahead", async () => {
    const f = await fixture()
    await f.store.facts.add({ type: "promise", statement: "Send the checklist", project: f.project.ref, by: "owner" })
    const preparationKnowledge = vi.fn(f.store.meetings.preparationKnowledge)
    const service = createMeetingPreparationService(f.key, f.accountId, {
      ...f.ports,
      meetings: { ...f.store.meetings, preparationKnowledge },
    })
    const result = await service.prepare("example-series", { ...f.request, contextLimit: 1 })
    expect(result.knowledge?.coverage.hasMore).toBe(true)
    expect(result.knowledge?.items).toHaveLength(1)
    expect(preparationKnowledge).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        accountId: f.accountId,
        anchorIds: [f.context.meetingId],
        limit: 1,
      }),
    )
    preparationKnowledge.mockClear()
    expect((await service.prepare("not-stored", f.request)).knowledge).toBeUndefined()
    expect(preparationKnowledge).not.toHaveBeenCalled()
  })

  it("propagates read failures and cancellation instead of reporting empty knowledge", async () => {
    const f = await fixture()
    const controller = new AbortController()
    const preparationKnowledge = vi.fn(async () => {
      controller.abort(new CliError("timeout", "Invented deadline"))
      return { items: [], hasMore: false }
    })
    const service = createMeetingPreparationService(f.key, f.accountId, {
      ...f.ports,
      meetings: { ...f.store.meetings, preparationKnowledge },
    })
    await expect(service.prepare("example-series", { ...f.request, signal: controller.signal })).rejects.toMatchObject({
      code: "timeout",
    })
    preparationKnowledge.mockRejectedValueOnce(new CliError("validation_error", "Invented byte overflow"))
    await expect(service.prepare("example-series", f.request)).rejects.toMatchObject({ code: "validation_error" })
  })

  it.each([
    { ref: "note:1" },
    { type: "invented" },
    { statement: "" },
    { subject: "meeting:1/1" },
    { project: "person:1" },
    { updatedAt: 10001 },
    { sharedPerson: true, subject: "project:1" },
    { sharedProject: false },
  ])("refuses invalid host facts %j", async (patch) => {
    const f = await fixture()
    const page = await f.store.meetings.preparationKnowledge({
      accountId: f.accountId,
      seriesId: f.context.seriesId,
      anchorIds: [f.context.meetingId],
      after: 0,
      before: 10000,
    })
    const preparationKnowledge = async () => ({
      ...page,
      items: [{ ...page.items[0], ...patch } as MeetingPreparationFact],
    })
    const service = createMeetingPreparationService(f.key, f.accountId, {
      ...f.ports,
      meetings: { ...f.store.meetings, preparationKnowledge },
    })
    await expect(service.prepare("example-series", f.request)).rejects.toMatchObject({ code: "invalid_response" })
  })
})
