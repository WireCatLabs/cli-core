import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { allHitItem } from "../cli/messenger/search-answers.js"
import type { SourceFile } from "../documents.js"
import { hit as hitEntity } from "../entities/hit.js"
import { type MeetingSave, READ_BUDGET_EXCEEDED } from "../meetings/index.js"
import { sampleMeeting } from "../meetings/testing/index.js"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import { documentIngestion } from "./documents/ingestion.js"
import { refreshMeetingIndex } from "./meeting-hit-search.js"
import { readMeetingPassage } from "./meeting-passage-format.js"
import type { SearchFound } from "./messages.js"
import { type SearchAllItem, type SearchAllRequest, searchAll } from "./search-all.js"
import { searchAllIncludingMeetings } from "./search-all-deprecated.js"
import type { MeetingSearchItem } from "./search-all-meetings.js"

const alice = { provider: "zoom", account: "zm-profile:alice" }
const bob = { provider: "zoom", account: "zm-profile:bob" }
const caller = { provider: "example", account: "caller" }
const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

type Line = string | { speaker: string; text: string }
const fixture = async () => {
  const folder = mkdtempSync(join(tmpdir(), "search-all-meetings-"))
  const path = join(folder, "wirecat.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path } })
  stores.push(store)
  await store.accounts.saveAccount(caller, { name: "Caller" })
  const save = async (
    account: AccountKey,
    externalId: string,
    lines: Line[],
    startedAt: number | null = 1000,
    extra: Partial<MeetingSave["meeting"]> = {},
    { index = true }: { index?: boolean } = {},
  ) => {
    const accountId = await store.accounts.saveAccount(account, { name: "Invented" })
    const sample = sampleMeeting()
    const saved = await store.meetings.saveMeeting({
      meeting: { ...sample.meeting, accountId, externalId, startedAt, title: "Invented call", ...extra },
      transcripts: [
        {
          ...sample.transcripts[0],
          contentHash: JSON.stringify(lines),
          rows: lines.map((line, position) => ({
            ...sample.transcripts[0].rows[0],
            position,
            speakerParticipantPosition: null,
            ...(typeof line === "string" ? { text: line } : { text: line.text, speakerName: line.speaker }),
          })),
        },
      ],
      now: 3000,
    })
    if (index) await refreshMeetingIndex(store.meetings, accountId)
    return { ...saved, accountId }
  }
  return { store, save }
}

const meetingsOnly = (extra: Partial<SearchAllRequest> = {}): SearchAllRequest => ({
  text: "needle",
  limit: 20,
  only: ["meetings"],
  meetingsAsked: true,
  ...extra,
})
const meetingHits = (items: SearchAllItem[]) =>
  items.filter((item): item is MeetingSearchItem => item.kind === "meeting")
const texts = (items: SearchAllItem[]) => items.map(({ text }) => text)

const messages = (...texts: string[]): SearchFound => ({
  items: texts.map((text, at) => ({
    id: String(at + 1),
    chatId: "7",
    senderId: "9",
    senderName: "Alice Example",
    timestamp: "2026-10-10T00:00:00Z",
    editedAt: null,
    text,
    outgoing: false,
    attachments: [],
    replyTo: null,
    forwardedFrom: null,
    reactions: null,
    chatTitle: "Invented chat",
    locator: `msg:example/caller/7/${at + 1}`,
  })),
  hasMore: false,
  corrections: [],
  completeness: [],
  wordsReady: true,
})

describe("meetings in search all", () => {
  it("reads every meeting account, names each one it read and ranks the meetings with the other sources", async () => {
    const { store, save } = await fixture()
    await save(alice, "a", ["needle from alice"], 2000)
    await save(bob, "b", ["needle from bob"], 1000)
    const found = await searchAll(store, caller, meetingsOnly({ only: ["messages", "meetings"] }), {}, async () =>
      messages("needle message one", "needle message two"),
    )
    expect(found.searched).toEqual(["messages", "meetings"])
    expect(found.accounts.filter(({ resource }) => resource === "meetings")).toEqual([
      { resource: "meetings", ...alice },
      { resource: "meetings", ...bob },
    ])
    expect(texts(found.items)).toEqual([
      "needle message one",
      "needle from alice",
      "needle message two",
      "needle from bob",
    ])
    expect(found.meetings).toEqual([
      { ...alice, indexing: "ready", hasMore: false },
      { ...bob, indexing: "ready", hasMore: false },
    ])
  })

  it("lets a newer hit of one account onto the page before the older hits of another", async () => {
    const { store, save } = await fixture()
    for (const [at, id] of ["a", "b", "c"].entries()) await save(alice, id, [`needle old ${id}`], 1000 - at)
    await save(bob, "new", ["needle new"], 5000)
    const found = await searchAll(store, caller, meetingsOnly({ limit: 2 }))
    expect(texts(found.items)).toEqual(["needle new", "needle old a"])
  })

  it("moves a meeting held in the period a question names onto the page", async () => {
    const { store, save } = await fixture()
    await save(alice, "march", ["needle in march"], Date.parse("2026-03-17T09:00:00Z"))
    await save(alice, "oct-a", ["needle in october"], Date.parse("2026-10-20T09:00:00Z"))
    await save(alice, "oct-b", ["needle later"], Date.parse("2026-10-21T09:00:00Z"))
    const asked = { now: Date.parse("2026-11-09T12:00:00Z"), timezone: "UTC", limit: 1 }
    expect(
      texts((await searchAll(store, caller, meetingsOnly({ ...asked, text: "what about the needle?" }))).items),
    ).not.toEqual(["needle in march"])
    expect(
      texts(
        (await searchAll(store, caller, meetingsOnly({ ...asked, text: "what about the needle in March?" }))).items,
      ),
    ).toEqual(["needle in march"])
  })

  it("reads only the meeting accounts --source names", async () => {
    const { store, save } = await fixture()
    await save(alice, "a", ["needle from alice"])
    await save(bob, "b", ["needle from bob"])
    const found = await searchAll(store, caller, meetingsOnly({ only: undefined, source: "zoom:zm-profile:bob" }))
    expect(texts(found.items)).toEqual(["needle from bob"])
    expect(found.accounts).toEqual([{ resource: "meetings", ...bob }])
  })

  it("leaves out a meeting account of the other scope", async () => {
    const { store, save } = await fixture()
    await save(alice, "a", ["needle from alice"])
    await save({ ...bob, scope: "work" }, "b", ["needle from bob"])
    const found = await searchAll(store, { ...caller, scope: "personal" }, meetingsOnly())
    expect(texts(found.items)).toEqual(["needle from alice"])
    expect(found.accounts).toEqual([{ resource: "meetings", ...alice }])
  })

  it("reads the scope of the caller's stored account unless the caller widens it", async () => {
    const { store, save } = await fixture()
    await save(alice, "a", ["needle from alice"])
    const office = { provider: "example", account: "office" }
    await store.accounts.saveAccount({ ...office, scope: "work" }, { name: "Office" })
    const narrow = await searchAll(store, office, meetingsOnly())
    expect(narrow.items).toEqual([])
    expect(narrow.skipped).toEqual([
      { resource: "meetings", code: "not_found", reason: "no meeting account in this scope" },
    ])
    const named = await searchAll(store, office, meetingsOnly({ only: undefined, source: "zoom:zm-profile:alice" }))
    expect(named.skipped).toContainEqual({
      source: "zoom:zm-profile:alice",
      code: "not_found",
      reason: "a personal account; this run reads work accounts",
    })
    const wide = await searchAll(store, office, meetingsOnly({ meetingScopes: ["personal", "work"] }))
    expect(texts(wide.items)).toEqual(["needle from alice"])
  })

  it("gives at most three passages of one meeting, each its own hit", async () => {
    const { store, save } = await fixture()
    const saved = await save(alice, "many", ["needle 1", "needle 2", "needle 3", "needle 4", "needle 5"], 2000)
    await save(alice, "other", ["needle elsewhere"], 1000)
    const found = await searchAll(store, caller, meetingsOnly())
    const hits = meetingHits(found.items)
    expect(hits.filter(({ meetingId }) => meetingId === saved.meeting.id)).toHaveLength(3)
    expect(new Set(hits.map(({ cueRef }) => cueRef)).size).toBe(hits.length)
    expect(texts(found.items)).toContain("needle elsewhere")
    expect(new Set(hits.map(({ ref }) => ref))).toEqual(
      new Set(hits.map(({ accountId, meetingId }) => `meeting:${accountId}/${meetingId}`)),
    )
  })

  it("names a transcript hit's cue and speaker, and meetings passage opens that cue", async () => {
    const { store, save } = await fixture()
    const saved = await save(alice, "cues", ["first line", "second line", "the needle line", "fourth line"])
    const [hit] = meetingHits((await searchAll(store, caller, meetingsOnly())).items)
    const transcript = saved.transcripts[0]?.transcript.id
    expect(hit).toMatchObject({
      ref: `meeting:${saved.accountId}/${saved.meeting.id}`,
      cueRef: `meeting:${saved.accountId}/${saved.meeting.id}/${transcript}/2`,
      speakerName: "Alice Example",
      title: "Invented call",
      timestamp: new Date(1000).toISOString(),
      foundBy: ["words"],
    })
    const { packet } = await readMeetingPassage(store.meetings, saved.accountId, hit?.cueRef ?? "", {
      before: 1,
      after: 1,
    })
    expect(packet.items.map(({ text }) => text)).toEqual(["second line", "the needle line", "fourth line"])
  })

  it("keeps the meeting query language: phrases, OR and NOT", async () => {
    const { store, save } = await fixture()
    await save(alice, "a", ["the needle plan"], 3000)
    await save(alice, "b", ["plan the needle"], 2000)
    await save(alice, "c", ["a haystack needle"], 1000)
    const ask = async (text: string) => texts((await searchAll(store, caller, meetingsOnly({ text }))).items)
    expect(await ask('"needle plan"')).toEqual(["the needle plan"])
    expect(await ask("haystack OR plan")).toEqual(["the needle plan", "plan the needle", "a haystack needle"])
    expect(await ask("needle NOT plan")).toEqual(["a haystack needle"])
  })

  it("finds a passage that holds some of a question's words", async () => {
    const { store, save } = await fixture()
    await save(alice, "a", ["we moved the delivery to Friday"])
    const found = await searchAll(store, caller, meetingsOnly({ text: "when is the delivery of the boxes?" }))
    expect(texts(found.items)).toEqual(["we moved the delivery to Friday"])
  })

  it("reads date: in the caller's timezone", async () => {
    const { store, save } = await fixture()
    // 23:30 on 1 March in UTC is already 2 March in Madrid.
    await save(alice, "late", ["needle late"], Date.parse("2026-03-01T23:30:00Z"))
    const on = async (timezone: string) =>
      texts((await searchAll(store, caller, meetingsOnly({ text: "needle date:2026-03-02", timezone }))).items)
    expect(await on("Europe/Madrid")).toEqual(["needle late"])
    expect(await on("UTC")).toEqual([])
  })

  it("skips only the account where from: names several speakers", async () => {
    const { store, save } = await fixture()
    await save(alice, "a", [
      { speaker: "Dana Example", text: "needle by one Dana" },
      { speaker: "Dana Sample", text: "needle by the other Dana" },
    ])
    await save(bob, "b", [{ speaker: "Dana Example", text: "needle by Dana" }])
    const found = await searchAll(store, caller, meetingsOnly({ text: "needle from:dana" }))
    expect(texts(found.items)).toEqual(["needle by Dana"])
    expect(found.skipped).toEqual([
      expect.objectContaining({ source: "zoom:zm-profile:alice", code: "validation_error" }),
    ])
    expect(found.accounts).toEqual([{ resource: "meetings", ...bob }])
  })

  it("skips meetings with the reason for a field they lack, and still answers the other sources", async () => {
    const { store, save } = await fixture()
    await save(alice, "a", ["needle"])
    for (const text of ["needle in:inbox", "needle chat:Team", "needle filename:plan.pdf"]) {
      const found = await searchAll(
        store,
        caller,
        meetingsOnly({ text, only: ["messages", "meetings"] }),
        {},
        async () => messages("needle message"),
      )
      expect(found.searched).toEqual(["messages"])
      expect(found.skipped).toEqual([
        expect.objectContaining({ resource: "meetings", code: "validation_error", reason: expect.any(String) }),
      ])
    }
  })

  it("matches only the word as typed with --exact", async () => {
    const { store, save } = await fixture()
    await save(alice, "a", ["needles everywhere"], 2000)
    await save(alice, "b", ["one needle"], 1000)
    expect(texts((await searchAll(store, caller, meetingsOnly())).items)).toEqual(["needles everywhere", "one needle"])
    expect(texts((await searchAll(store, caller, meetingsOnly({ exact: true }))).items)).toEqual(["one needle"])
  })

  it("reports an account whose index is not built yet, and does not build it", async () => {
    const { store, save } = await fixture()
    await save(alice, "a", ["needle"], 1000, {}, { index: false })
    const index = vi.spyOn(store.meetings, "indexSearch")
    const found = await searchAll(store, caller, meetingsOnly())
    expect(found.meetings).toEqual([{ ...alice, indexing: "pending", hasMore: false }])
    expect(index).not.toHaveBeenCalled()
  })

  it("cuts a long passage to an excerpt around the match", async () => {
    const { store, save } = await fixture()
    await save(alice, "long", [`${"filler words ".repeat(60)}the needle${" more filler".repeat(60)}`])
    const [hit] = (await searchAll(store, caller, meetingsOnly())).items
    expect(hit?.text.length).toBeLessThanOrEqual(242)
    expect(hit?.text).toContain("needle")
  })

  it("says which hit was found only through a garbled spelling, and centres its excerpt on that spelling", async () => {
    const { store, save } = await fixture()
    await save(alice, "garbled", [
      "Итог: нужен риелтор для квартиры",
      `${"длинное вступление ".repeat(20)}позвонили реелтора вечером`,
    ])
    const items = (await searchAll(store, caller, meetingsOnly({ text: "риелтор" }))).items.map(allHitItem)
    expect(items.map((item) => v.parse(hitEntity, item))).toEqual(items)
    expect(items.map(({ match, corrections }) => ({ match, corrections }))).toEqual([
      { match: undefined, corrections: undefined },
      { match: "corrected", corrections: [{ from: "риелтор", to: ["реелтора"] }] },
    ])
    expect(items[1]?.excerpt).toContain("реелтора")
  })

  it("reads the index in pages of at most 200 rows, and keeps paging", async () => {
    const { store, save } = await fixture()
    for (const id of ["a", "b"])
      await save(
        alice,
        id,
        Array.from({ length: 150 }, (_, at) => `needle ${id} ${at}`),
      )
    const pages = vi.spyOn(store.meetings, "searchHits")
    const found = await searchAll(store, caller, meetingsOnly({ limit: 100 }))
    expect(found.items).toHaveLength(6)
    expect(pages.mock.calls.map(([, input]) => input.limit)).toEqual([101, 101, 101])
    const wide = await searchAll(store, caller, meetingsOnly({ limit: 100, offset: 900 }))
    expect(wide.items).toEqual([])
    expect(pages.mock.calls.slice(3).map(([, input]) => input.limit)).toEqual([200, 200])
  })

  it("centres the excerpt on the form the index matched, never on a word under NOT", async () => {
    const { store, save } = await fixture()
    const filler = "filler words ".repeat(30)
    await save(alice, "forms", [`haystack early ${filler}the plans moved ${filler}`])
    const ask = async (text: string) => (await searchAll(store, caller, meetingsOnly({ text }))).items[0]?.text ?? ""
    expect(await ask("planning")).toContain("plans moved")
    const negated = await ask("moved NOT stack")
    expect(negated).toContain("plans moved")
    expect(negated).not.toContain("haystack")
  })

  it("pages by offset through the merged list without repeating a hit", async () => {
    const { store, save } = await fixture()
    for (const [at, id] of ["a", "b", "c", "d", "e"].entries()) await save(alice, id, [`needle ${id}`], 5000 - at)
    const first = await searchAll(store, caller, meetingsOnly({ limit: 2 }))
    const second = await searchAll(store, caller, meetingsOnly({ limit: 2, offset: first.nextOffset }))
    const third = await searchAll(store, caller, meetingsOnly({ limit: 2, offset: second.nextOffset }))
    expect([first, second, third].flatMap(({ items }) => texts(items))).toEqual([
      "needle a",
      "needle b",
      "needle c",
      "needle d",
      "needle e",
    ])
    expect(first.hasMore).toBe(true)
    expect(third.hasMore).toBe(false)
    expect(third.nextOffset).toBeUndefined()
  })

  it("finds nothing in a deleted meeting or a replaced transcript", async () => {
    const { store, save } = await fixture()
    await save(alice, "corrected", ["needle old"])
    await save(alice, "corrected", ["replacement text"])
    await save(alice, "deleted", ["needle deleted"], 2000, { deletedAt: 3000 })
    const found = await searchAll(store, caller, meetingsOnly())
    expect(found.items).toEqual([])
    expect(found.hasMore).toBe(false)
  })

  it("finds a meeting by its title alone", async () => {
    const { store, save } = await fixture()
    const saved = await save(alice, "titled", ["nothing to see"], 1000, { title: "Needle review" })
    const [hit, ...rest] = meetingHits((await searchAll(store, caller, meetingsOnly())).items)
    expect(rest).toEqual([])
    expect(hit).toMatchObject({
      ref: `meeting:${saved.accountId}/${saved.meeting.id}`,
      scope: "title",
      id: saved.meeting.id,
      title: "Needle review",
      text: "Needle review",
      foundBy: ["title"],
    })
    expect(hit).not.toHaveProperty("cueRef")
  })

  it("matches a title's words from their start, as passages are matched", async () => {
    const { store, save } = await fixture()
    await save(alice, "titled", ["nothing to see"], 1000, { title: "Monday planning" })
    const titles = async (text: string) =>
      meetingHits((await searchAll(store, caller, meetingsOnly({ text }))).items).map(({ title }) => title)
    expect(await titles("plan")).toEqual(["Monday planning"])
    expect(await titles("monday")).toEqual(["Monday planning"])
    expect(await titles("anning")).toEqual([])
  })

  it("gives a title and a passage of one meeting as two hits", async () => {
    const { store, save } = await fixture()
    await save(alice, "both", ["the needle again"], 1000, { title: "Needle review" })
    const hits = meetingHits((await searchAll(store, caller, meetingsOnly())).items)
    expect(hits.map(({ scope, text }) => [scope, text])).toEqual([
      ["title", "Needle review"],
      ["transcript", "the needle again"],
    ])
  })

  it("ranks a title hit with the passages, so a newer passage comes before older titles", async () => {
    const { store, save } = await fixture()
    for (let at = 0; at < 25; at++)
      await save(alice, `weekly-${at}`, ["nothing to see"], 1000 + at, { title: "Weekly needle" })
    await save(alice, "fresh", ["the needle decision"], 9000, { title: "Planning" })
    const [first] = meetingHits((await searchAll(store, caller, meetingsOnly({ limit: 5 }))).items)
    expect(first).toMatchObject({ scope: "transcript", text: "the needle decision" })
  })

  it("matches a title for a question only when it holds every word, so titles do not bury the answer", async () => {
    const { store, save } = await fixture()
    for (let at = 0; at < 25; at++)
      await save(alice, `weekly-${at}`, ["nothing to see"], 5000 + at, { title: "Weekly meeting" })
    await save(alice, "budget", ["we agreed the budget at the weekly meeting"], 1000, { title: "Planning" })
    await save(alice, "titled", ["nothing to see"], 900, { title: "Weekly budget meeting" })
    const hits = meetingHits(
      (await searchAll(store, caller, meetingsOnly({ text: "when is the weekly budget meeting?", limit: 5 }))).items,
    )
    expect(hits.map(({ scope, text }) => [scope, text])).toEqual([
      ["transcript", "we agreed the budget at the weekly meeting"],
      ["title", "Weekly budget meeting"],
    ])
  })

  it("matches a title's whole words with --exact", async () => {
    const { store, save } = await fixture()
    await save(alice, "titled", ["nothing to see"], 1000, { title: "Needle review" })
    const titles = async (text: string) =>
      meetingHits((await searchAll(store, caller, meetingsOnly({ text, exact: true }))).items).map(({ title }) => title)
    expect(await titles("needle")).toEqual(["Needle review"])
    expect(await titles("need")).toEqual([])
    expect(await titles('"needle review"')).toEqual(["Needle review"])
  })

  it("matches no title when the query names a speaker", async () => {
    const { store, save } = await fixture()
    await save(alice, "both", [{ speaker: "Dana Example", text: "the needle again" }], 1000, {
      title: "Needle review",
    })
    const hits = meetingHits((await searchAll(store, caller, meetingsOnly({ text: "needle from:dana" }))).items)
    expect(hits.map(({ scope }) => scope)).toEqual(["transcript"])
  })

  it("says no meeting account is stored when the store holds none", async () => {
    const { store } = await fixture()
    const found = await searchAll(store, caller, meetingsOnly())
    expect(found.searched).toEqual([])
    expect(found.skipped).toEqual([{ resource: "meetings", code: "not_found", reason: "no meeting account stored" }])
    expect(found).not.toHaveProperty("meetings")
  })

  it("says nothing of meetings it was not asked for when the store holds none", async () => {
    const { store } = await fixture()
    const found = await searchAll(store, caller, meetingsOnly({ only: undefined, meetingsAsked: undefined }))
    expect(found.skipped.filter(({ resource }) => resource === "meetings")).toEqual([])
    expect(found.searched).not.toContain("meetings")
  })

  it("says the caller's account is not in the store yet when it cannot know the caller's scope", async () => {
    const { store, save } = await fixture()
    await save(alice, "a", ["needle from alice"])
    const stranger = { provider: "example", account: "stranger" }
    const found = await searchAll(store, stranger, meetingsOnly())
    expect(found.items).toEqual([])
    expect(found.skipped).toEqual([
      { resource: "meetings", code: "not_found", reason: "this account is not in the store yet" },
    ])
  })

  it("asks for half the rows when a page's stored text passes the byte budget, before it skips the account", async () => {
    const { store, save } = await fixture()
    await save(alice, "a", ["needle from alice"])
    const read = store.meetings.searchHits.bind(store.meetings)
    const pages = vi.spyOn(store.meetings, "searchHits").mockImplementation(async (query, input) => {
      if ((input.limit ?? 100) > 30) throw new CliError("validation_error", READ_BUDGET_EXCEEDED)
      return read(query, input)
    })
    const found = await searchAll(store, caller, meetingsOnly({ limit: 100 }))
    expect(texts(found.items)).toEqual(["needle from alice"])
    expect(pages.mock.calls.map(([, input]) => input.limit)).toEqual([101, 51, 26])
    pages.mockImplementation(async () => {
      throw new CliError("validation_error", READ_BUDGET_EXCEEDED)
    })
    const refused = await searchAll(store, caller, meetingsOnly())
    expect(refused.skipped).toEqual([
      { source: `zoom:${alice.account}`, code: "validation_error", reason: READ_BUDGET_EXCEEDED },
    ])
  })

  it("keeps the deprecated searchAllIncludingMeetings to the meeting account it names", async () => {
    const { store, save } = await fixture()
    await save(alice, "a", ["needle from alice"])
    await save(bob, "b", ["needle from bob"])
    const found = await searchAllIncludingMeetings(store, caller, {
      text: "needle",
      limit: 20,
      only: ["meetings"],
      meetingAccount: alice,
      maxMeetings: 1,
    })
    expect(texts(found.items)).toEqual(["needle from alice"])
    expect(found.meetings).toBeUndefined()
  })
})

describe("a Meet transcript that Drive also imported", () => {
  const drive = (store: MessageStore) =>
    documentIngestion<SourceFile>(store, {
      provider: "google-drive",
      externalId: (id) => `${id}.md`,
      catalogInput: (file) => ({
        externalId: `${file.id}.md`,
        name: file.name,
        parents: [],
        kind: "file",
        url: file.url,
      }),
      frontMatter: (content) => ({
        source: "google-drive",
        fileId: content.metadata.id,
        sourceUrl: content.metadata.url,
      }),
    })
  const transcriptDoc = async (store: MessageStore, text: string) => {
    const file: SourceFile = {
      id: "doc-transcript-1",
      name: "Invented call - Transcript",
      mime: "application/vnd.google-apps.document",
      parents: [],
      url: "https://docs.google.com/document/d/doc-transcript-1",
      trashed: false,
      canDownload: true,
    }
    const ref = await drive(store).save(
      "owner@example.invalid",
      { metadata: file, text, markdown: text, tabs: [] },
      text,
    )
    return Number(ref.slice("document:".length))
  }
  const withDocument = async (save: Awaited<ReturnType<typeof fixture>>["save"], store: MessageStore) => {
    const saved = await save(alice, "meet-1", ["needle in the transcript"])
    const sample = sampleMeeting()
    await store.meetings.saveMeeting({
      meeting: { ...sample.meeting, accountId: saved.accountId, externalId: "meet-1", title: "Invented call" },
      transcripts: [
        {
          ...sample.transcripts[0],
          source: "meet",
          contentHash: "meet-transcript",
          driveFileId: "doc-transcript-1",
          rows: [
            { ...sample.transcripts[0].rows[0], speakerParticipantPosition: null, text: "needle in the transcript" },
          ],
        },
      ],
      now: 4000,
    })
    await refreshMeetingIndex(store.meetings, saved.accountId)
    return saved
  }
  const asked = meetingsOnly({ only: ["notes", "meetings"] })

  it("shows the meeting once, whichever of the two the store holds first", async () => {
    for (const driveFirst of [true, false]) {
      const { store, save } = await fixture()
      const document = driveFirst ? await transcriptDoc(store, "needle in the transcript") : undefined
      const saved = await withDocument(save, store)
      const id = document ?? (await transcriptDoc(store, "needle in the transcript"))
      expect(await store.meetings.transcriptMeetings([id])).toEqual(new Map([[id, saved.meeting.id]]))
      const found = await searchAll(store, caller, asked)
      expect(found.items.filter((item) => item.ref === `document:${id}`)).toEqual([])
      expect(meetingHits(found.items).length).toBeGreaterThan(0)
    }
  })

  it("keeps the document's hit when the meeting is not among the hits", async () => {
    const { store, save } = await fixture()
    const id = await transcriptDoc(store, "needle and a haystack only the document has")
    await withDocument(save, store)
    const found = await searchAll(store, caller, { ...asked, text: "haystack" })
    expect(found.items.map(({ ref }) => ref)).toEqual([`document:${id}`])
  })
})
