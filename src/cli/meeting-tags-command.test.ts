import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import * as v from "valibot"
import { afterEach, expect, it } from "vitest"
import { addMeetingSearchCommand } from "../meetings/cli/index.js"
import { type MeetingSave, meetingTagChange, meetingTagging } from "../meetings/index.js"
import { sampleMeeting } from "../meetings/testing/index.js"
import { searchMeetingHits } from "../services/meeting-hit-search.js"
import { meetingTags } from "../services/meeting-tags.js"
import { type MessageStore, openStore } from "../store/store.js"
import { addMeetingTagsCommand } from "./meeting-tags-command.js"
import { pagingOf } from "./paging.js"
import { run } from "./program.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const call = (accountId: number, id: string, startedAt: number, lines: string[]): MeetingSave => {
  const input = sampleMeeting()
  delete input.meeting.series
  const [transcript] = input.transcripts
  const [row] = transcript.rows
  return {
    ...input,
    meeting: { ...input.meeting, accountId, externalId: id, title: `Call ${id}`, startedAt },
    transcripts: [
      {
        ...transcript,
        contentHash: `hash-${id}`,
        rows: lines.map((text, position) => ({ ...row, position, startMs: position * 1000, text })) as [
          typeof row,
          ...(typeof row)[],
        ],
      },
    ],
    chat: [],
    summaries: [],
  } as MeetingSave
}

const seed = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "pbx-test-tags-")), "store.db") })
  stores.push(store)
  const office = await store.accounts.saveAccount({ provider: "asterisk", account: "office" }, { name: "Office" })
  const sales = await store.accounts.saveAccount({ provider: "beeline", account: "sales" }, { name: "Sales" })
  const save = async (accountId: number, id: string, startedAt: number, lines: string[]) =>
    (await store.meetings.saveMeeting(call(accountId, id, startedAt, lines))).meeting.id
  const ids = {
    refund: await save(office, "1001", Date.UTC(2026, 10, 2, 9), ["Hello", "I want a refund for the order"]),
    twice: await save(office, "1002", Date.UTC(2026, 10, 3, 9), ["Refund please", "yes, the refund"]),
    other: await save(office, "1003", Date.UTC(2026, 10, 4, 9), ["What time do you open?"]),
    elsewhere: await save(sales, "2001", Date.UTC(2026, 10, 2, 9), ["A refund on another line"]),
  }
  return { store, office, sales, ids }
}

const definitionFor = (store: MessageStore, accountId: number) => ({
  app: { command: "pbx", appName: "pbx-cli", envPrefix: "PBX", description: "synthetic", version: "1.0.0" },
  commands: () => {
    const holder = new Command("pbx")
    addMeetingTagsCommand(holder, {
      read: async () => meetingTags(store, accountId),
      examples: {
        add: ['pbx office tags add complaint --matching "refund OR complaint" --json'],
        remove: ["pbx office tags remove complaint --meeting 12 --json"],
        list: ["pbx office tags list tag:complaint --json"],
      },
    })
    addMeetingSearchCommand(holder, {
      search: (query, request) => searchMeetingHits(store, query, { ...request, accountId }),
      signal: () => undefined,
      pagingOf,
      output: (body) => answers.push(body),
    })
    return [...holder.commands]
  },
})

const answers: unknown[] = []

const pbx = async (store: MessageStore, accountId: number, ...args: string[]) => {
  const streams = captureStreams()
  const code = await run([...args, "--json", "--no-record"], definitionFor(store, accountId), {
    streams,
    tty: false,
    env: {},
  })
  const out = streams.stdout.join("")
  return { code, answer: out === "" ? undefined : JSON.parse(out), stderr: streams.stderr.join("") }
}

it("marks every call of the account where the words are said, and a rerun marks only the new ones", async () => {
  const { store, office, ids } = await seed()

  const first = await pbx(store, office, "tags", "add", "complaint", "--matching", "refund")
  expect(first.stderr).toBe("")
  expect(first.code).toBe(0)
  v.parse(meetingTagChange, first.answer.item)
  expect(first.answer.item).toMatchObject({ tags: ["complaint"], matched: 2 })
  expect(first.answer.item.changed).toHaveLength(2)
  for (const id of [ids.refund, ids.twice])
    expect(first.answer.item.changed).toContainEqual({
      meeting: `meeting:${office}/${id}`,
      meeting_id: id,
      tags: ["complaint"],
    })

  const later = await store.meetings.saveMeeting(call(office, "1004", Date.UTC(2026, 10, 5, 9), ["refund, again"]))
  const rerun = await pbx(store, office, "tags", "add", "complaint", "--matching", "refund")
  expect(rerun.answer.item).toEqual({
    tags: ["complaint"],
    matched: 3,
    changed: [{ meeting: `meeting:${office}/${later.meeting.id}`, meeting_id: later.meeting.id, tags: ["complaint"] }],
  })

  const listed = await pbx(store, office, "tags", "list", "tag:complaint")
  expect(listed.code).toBe(0)
  for (const item of listed.answer.items) v.parse(meetingTagging, item)
  expect(listed.answer.items.map((item: { meeting_id: number }) => item.meeting_id).sort()).toEqual(
    [ids.refund, ids.twice, later.meeting.id].sort(),
  )
  expect(listed.answer.items[0]).toMatchObject({ tags: ["complaint"], untrusted: ["title"] })
  expect(listed.answer.items[0].title).toMatch(/^Call 100/)
})

it("search meetings selects the marked calls with --tag", async () => {
  const { store, office, ids } = await seed()
  await pbx(store, office, "tags", "add", "complaint", "--meeting", String(ids.twice))
  answers.length = 0

  await pbx(store, office, "search", "meetings", "refund", "--tag", "complaint")

  const [body] = answers as { items: { meeting: string; excerpt: string; line?: number }[] }[]
  expect(body?.items.map((hit) => hit.meeting)).toEqual([
    `meeting:${office}/${ids.twice}`,
    `meeting:${office}/${ids.twice}`,
  ])
})

it("takes a mark off by id, and never reaches another account's meeting", async () => {
  const { store, office, ids } = await seed()
  await pbx(
    store,
    office,
    "tags",
    "add",
    "complaint",
    "vip",
    "--meeting",
    String(ids.refund),
    "--meeting",
    String(ids.other),
  )

  const removed = await pbx(store, office, "tags", "remove", "vip", "--meeting", String(ids.refund))
  expect(removed.answer.item).toEqual({
    tags: ["vip"],
    matched: 1,
    changed: [{ meeting: `meeting:${office}/${ids.refund}`, meeting_id: ids.refund, tags: ["vip"] }],
  })

  const foreign = await pbx(store, office, "tags", "add", "vip", "--meeting", String(ids.elsewhere))
  expect(foreign.code).not.toBe(0)
  expect(foreign.stderr).toContain("not_found")
  await store.knowledge.addTags(
    { provider: "beeline", account: "sales" },
    { type: "meeting", id: String(ids.elsewhere) },
    ["vip"],
  )
  const listed = await pbx(store, office, "tags", "list")
  expect(
    listed.answer.items.map((item: { meeting_id: number; tags: string[] }) => [item.meeting_id, item.tags]),
  ).toEqual([
    [ids.refund, ["complaint"]],
    [ids.other, ["complaint", "vip"]],
  ])
})

it("asks for exactly one of --meeting and --matching", async () => {
  const { store, office, ids } = await seed()
  for (const args of [[], ["--meeting", String(ids.refund), "--matching", "refund"]]) {
    const refused = await pbx(store, office, "tags", "add", "complaint", ...args)
    expect(refused.code).not.toBe(0)
    expect(JSON.stringify(refused.answer ?? refused.stderr)).toContain("--matching")
  }
})
