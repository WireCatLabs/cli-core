import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"
import { addMeetingCommands } from "../meetings/cli/index.js"
import { listed, type MeetingStore } from "../meetings/index.js"
import { flagPaging, memoryMeetingStore, sampleMeeting } from "../meetings/testing/index.js"
import { openStore } from "../store/store.js"
import { answerSchema, type Body } from "./envelope.js"
import { meetingAnswerBody } from "./meeting-answer-body.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const saveTwo = async (store: MeetingStore, accountId: number) => {
  for (const externalId of ["example-a", "example-b"]) {
    const sample = sampleMeeting()
    await store.saveMeeting({ ...sample, meeting: { ...sample.meeting, accountId, externalId } })
  }
}

/** The shared meetings commands as a host mounts them, with `write` turned into the host's body. */
const host = (store: MeetingStore, accountId: number) => {
  const bodies: Body[] = []
  const run = async (...args: string[]) => {
    const program = new Command().exitOverride().configureOutput({ writeOut() {}, writeErr() {} })
    program.option("--offline").option("--json")
    addMeetingCommands(program, {
      store,
      accountId,
      pagingOf: flagPaging,
      write: (value, _format, command) => bodies.push(meetingAnswerBody(command, value)),
      inRun: (_command, body) => body(),
    })
    await program.parseAsync(["--offline", ...args, "--json"], { from: "user" })
    const body = bodies.at(-1) as Body
    expect(
      v.safeParse(answerSchema(), { ...body, meta: { run_id: "run", duration_ms: 0, complete: true } }).issues,
    ).toBeUndefined()
    return body as Body & Record<string, unknown>
  }
  return run
}

describe("meetingAnswerBody", () => {
  it("keeps meetings list's page.next, naming the running command", async () => {
    const store = memoryMeetingStore()
    await saveTwo(store, 1)
    const body = await host(store, 1)("meetings", "list", "--limit", "1")
    expect(body.next).toMatchObject([{ step: "page.next", command: "meetings list", args: { page: 2, limit: 1 } }])
    expect(body.page).toMatchObject({ mode: "page", has_more: true, next_page: 2 })
  })

  it("answers meetings people's packet as one item, its page.next step on the answer", async () => {
    const opened = await openStore({ path: join(mkdtempSync(join(tmpdir(), "meeting-answer-body-")), "store.db") })
    handles.push(opened)
    const accountId = await opened.accounts.saveAccount({ provider: "example", account: "invented" }, { name: null })
    await saveTwo(opened.meetings, accountId)
    const body = await host(opened.meetings, accountId)("meetings", "people", "Alice", "--limit", "1")
    expect(body.item).toMatchObject({ kind: "meeting_participants", page: { mode: "cursor", has_more: true } })
    expect(body.item).not.toHaveProperty("next")
    expect(body.next).toMatchObject([{ step: "page.next", command: "meetings people" }])
  })

  it("turns a listed() page into a list answer whose page.next reruns the command at the next page", async () => {
    expect(meetingAnswerBody("events list", listed([{ eventId: 1 }], { limit: 1, hasMore: true, page: 2 }))).toEqual({
      items: [{ event_id: 1 }],
      page: { mode: "page", limit: 1, has_more: true, next_page: 3 },
      next: [expect.objectContaining({ step: "page.next", command: "events list", args: { page: 3, limit: 1 } })],
    })
    const body = await host(memoryMeetingStore(), 1)("events", "list")
    expect(body).toMatchObject({ items: [], page: { mode: "page", limit: 1, has_more: false } })
  })

  it("keeps a listed() page's meta and missing", () => {
    const missing = [{ field: "server", why: "not asked" }]
    expect(meetingAnswerBody("events list", { ...listed([]), missing, meta: { complete: false } })).toEqual({
      items: [],
      page: { mode: "page", limit: 1, has_more: false },
      missing,
      meta: { complete: false },
    })
  })

  it("keeps an item answer with missing and meta, in snake_case, and answers any other value as one item", () => {
    expect(
      meetingAnswerBody("meetings show", { item: { foundIn: "server" }, missing: [], meta: { complete: true } }),
    ).toEqual({ item: { found_in: "server" }, missing: [], meta: { complete: true } })
    expect(meetingAnswerBody("meetings sync", { meetingsSaved: 2 })).toEqual({ item: { meetings_saved: 2 } })
    expect(meetingAnswerBody("meetings export", "text")).toEqual({ item: "text" })
  })
})
