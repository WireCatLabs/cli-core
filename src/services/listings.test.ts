import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"
import { documentListRequest, meetingListRequest } from "../cli/listings.js"
import {
  documentEntry,
  documentEntryDetails,
  documentSource,
  meetingEntry,
  meetingEntryDetails,
} from "../entities/listings.js"
import type { EntryInput, MeetingFindingsInput } from "../meetings/index.js"
import { sampleMeeting } from "../meetings/testing/index.js"
import { openCache } from "../store/open.js"
import { type MessageStore, openStore } from "../store/store.js"
import { listDocumentSources, listDocuments, listMeetingEntries, showDocument, showMeetingEntry } from "./listings.js"
import { cueEvidence } from "./meeting-evidence.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})
const paths = new WeakMap<MessageStore, string>()

const open = async () => {
  let at = Date.parse("2026-11-02T09:00:00Z")
  const path = join(mkdtempSync(join(tmpdir(), "listings-")), "store.db")
  const store = await openStore({ path, now: () => (at += 1000) })
  opened.push(store)
  paths.set(store, path)
  return store
}

const NOW = Date.parse("2026-11-13T12:00:00Z")
const page = { limit: 50, page: 1, zone: "UTC", now: NOW }

describe("the documents of every account", () => {
  const setup = async () => {
    const store = await open()
    const notes = (await store.notes.addFolder({ name: "Synthetic notes" })).id
    const drive = String(
      await store.accounts.saveAccount({ provider: "google-drive", account: "ana" }, { name: "Ana" }),
    )
    const save = (folderId: string, path: string, text: string) =>
      store.notes.saveFileNote({ folderId, path, title: path.split("/").at(-1) ?? path, text })
    await save(notes, "Projects/Acme/brief.md", "the budget for the invented launch")
    await save(notes, "Projects/Acme/Notes/call.txt", "a call about nothing")
    await save(notes, "inbox.md", "loose thoughts")
    await save(drive, "Shared/plan.pdf", "budget plan")
    await store.notes.saveAddedSource({
      kind: "text",
      text: "pasted budget",
      read: "extracted",
      title: "Pasted",
      by: "owner",
    })
    await store.catalog.upsert(drive, [
      { externalId: "scan.pdf", kind: "file", name: "Scan", mime: "application/pdf", parents: [] },
    ])
    return { store, notes, drive }
  }

  it("lists every account's documents with their source, folder and kind, and counts them all", async () => {
    const { store } = await setup()
    const found = await listDocuments(store, documentListRequest([], { ...page, limit: 2 }))
    expect(found.total).toEqual({ value: 6, relation: "eq" })
    expect(found.items).toHaveLength(2)
    const third = await listDocuments(store, documentListRequest([], { ...page, limit: 2, page: 3 }))
    const second = await listDocuments(store, documentListRequest([], { ...page, limit: 2, page: 2 }))
    const refs = [...found.items, ...second.items, ...third.items].map(({ ref }) => ref)
    expect(new Set(refs).size).toBe(6)
    expect(found.accounts.sort()).toEqual(expect.arrayContaining(["added:owner", "google-drive:ana"]))
    const all = await listDocuments(store, documentListRequest([], page))
    for (const item of all.items) expect(v.safeParse(documentEntry, item).issues).toBeUndefined()
    const brief = all.items.find((item) => item.path === "Projects/Acme/brief.md")
    expect(brief).toMatchObject({ kind: "md", folder: "Projects/Acme", has_text: true })
    expect(brief?.source.label).toBe("obsidian · Synthetic notes")
    expect(all.items.find((item) => item.title === "Scan")).toMatchObject({ kind: "pdf", has_text: false })
  })

  it("narrows by source, kind, folder and text, the text found as search notes finds it", async () => {
    const { store } = await setup()
    const list = async (words: string) =>
      (await listDocuments(store, documentListRequest(words, page))).items.map(({ path, title }) => path ?? title)
    expect((await list("source:google-drive")).sort()).toEqual(["Scan", "Shared/plan.pdf"])
    expect((await list("kind:txt")).sort()).toEqual(["Pasted", "Projects/Acme/Notes/call.txt"])
    expect((await list("kind:txt kind:pdf")).length).toBe(4)
    expect((await list('folder:"Projects/Acme"')).sort()).toEqual([
      "Projects/Acme/Notes/call.txt",
      "Projects/Acme/brief.md",
    ])
    expect((await list("budget")).sort()).toEqual(["Pasted", "Projects/Acme/brief.md", "Shared/plan.pdf"])
    expect(await list("budget source:google-drive")).toEqual(["Shared/plan.pdf"])
    expect(await list('folder:"Projects/Acme/brief.md"')).toEqual([])
    await expect(list("source:dropbox")).rejects.toMatchObject({ code: "not_found" })
  })

  it("gives each account's folder tree with counts, parents first", async () => {
    const { store } = await setup()
    const sources = await listDocumentSources(store, { depth: 3 })
    for (const source of sources) expect(v.safeParse(documentSource, source).issues).toBeUndefined()
    const notes = sources.find(({ provider }) => provider === "obsidian")
    expect(notes).toMatchObject({ count: 3, loose: 1 })
    expect(notes?.folders).toEqual([
      { path: "Projects", name: "Projects", depth: 1, count: 2 },
      { path: "Projects/Acme", name: "Acme", depth: 2, count: 2 },
      { path: "Projects/Acme/Notes", name: "Notes", depth: 3, count: 1 },
    ])
    expect(
      (await listDocumentSources(store, { depth: 1 })).find(({ provider }) => provider === "obsidian")?.folders,
    ).toEqual([{ path: "Projects", name: "Projects", depth: 1, count: 2 }])
  })

  it("shows a part of a document's text and says more follows", async () => {
    const { store } = await setup()
    const { items } = await listDocuments(store, documentListRequest('folder:"Projects/Acme" kind:md', page))
    const shown = await showDocument(store, items[0]?.ref as string, { offset: 4, limit: 6 })
    expect(v.safeParse(documentEntryDetails, shown).issues).toBeUndefined()
    expect(shown).toMatchObject({ text: "budget", text_offset: 4, has_more: true, tags: [], meetings: [] })
    await expect(showDocument(store, "document:999999", { offset: 0, limit: 10 })).rejects.toMatchObject({
      code: "not_found",
    })
  })

  describe("counts the text in code points, the unit of --cursor and --max-chars", () => {
    const saved = async (text: string) => {
      const store = await open()
      const notes = (await store.notes.addFolder({ name: "Synthetic notes" })).id
      await store.notes.saveFileNote({ folderId: notes, path: "unicode.md", title: "unicode", text })
      const { items } = await listDocuments(store, documentListRequest("kind:md", page))
      return { store, ref: items[0]?.ref as string }
    }
    const readAll = async (text: string, limit: number) => {
      const { store, ref } = await saved(text)
      const parts: { text: string; text_offset: number; text_length: number; has_more: boolean }[] = []
      for (let cursor = 0; ; ) {
        const shown = await showDocument(store, ref, { offset: cursor, limit })
        parts.push({ ...shown, text: shown.text ?? "" })
        if (!shown.has_more) break
        cursor = shown.text_offset + [...(shown.text ?? "")].length
      }
      return parts
    }

    it("says more follows when emoji make the part longer than its code points", async () => {
      const { store, ref } = await saved("😀😀😀😀abc")
      expect(await showDocument(store, ref, { offset: 0, limit: 4 })).toMatchObject({
        text: "😀😀😀😀",
        text_offset: 0,
        text_length: 7,
        has_more: true,
      })
      expect(await showDocument(store, ref, { offset: 4, limit: 4 })).toMatchObject({ text: "abc", has_more: false })
    })

    it.each([
      ["emoji", "a😀b👩‍💻c🎉🎉d"],
      ["a surrogate pair at every cut", "😀".repeat(9)],
      ["CJK", "日本語のテキストと한국어 텍스트"],
      ["combining marks", "éäô café"],
    ])("pages through %s without losing or splitting a character", async (_, text) => {
      for (const limit of [1, 2, 3, 5]) {
        const parts = await readAll(text, limit)
        expect(parts.map((part) => part.text).join("")).toBe(text)
        expect(parts.map((part) => part.has_more)).toEqual(parts.map((_, at) => at < parts.length - 1))
        for (const part of parts) {
          expect(part.text_length).toBe([...text].length)
          expect(part.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u)
        }
      }
    })
  })
})

describe("meetings, calls and events as one row per real meeting", () => {
  const ZOOM = "https://us02web.zoom.us/j/123456789?pwd=secret"
  const at = (iso: string) => Date.parse(iso)
  const entry = (externalId: string, more: Partial<EntryInput>): EntryInput => ({
    externalId,
    kind: "single",
    status: "confirmed",
    title: externalId,
    startsAt: at("2026-11-10T10:00:00Z"),
    endsAt: at("2026-11-10T11:00:00Z"),
    ...more,
  })
  const setup = async () => {
    const store = await open()
    const calendarAccount = await store.accounts.saveAccount(
      { provider: "google-calendar", account: "ana" },
      { name: null },
    )
    const [calendar] = await store.calendar.saveCalendars(
      calendarAccount,
      [
        {
          externalId: "primary",
          title: "Work",
          timezone: "UTC",
          accessRole: "owner",
          primary: true,
          syncByDefault: true,
        },
      ],
      1,
    )
    const zoom = await store.accounts.saveAccount({ provider: "zoom", account: "ana" }, { name: null })
    await store.calendar.saveEntries(
      calendar?.id as number,
      [
        entry("Weekly sync", { joinUrl: ZOOM }),
        entry("Weekly sync next", {
          joinUrl: ZOOM,
          startsAt: at("2026-11-17T10:00:00Z"),
          endsAt: at("2026-11-17T11:00:00Z"),
        }),
        entry("Lunch", { startsAt: at("2026-11-11T12:00:00Z"), endsAt: at("2026-11-11T13:00:00Z") }),
        entry("Call with Bob", {
          eventType: "call",
          startsAt: at("2026-11-09T08:00:00Z"),
          endsAt: at("2026-11-09T08:10:00Z"),
        }),
        entry("Old review", { startsAt: at("2026-08-01T10:00:00Z"), endsAt: at("2026-08-01T11:00:00Z") }),
      ],
      1,
    )
    const base = sampleMeeting()
    const zoomed = await store.meetings.saveMeeting({
      ...base,
      meeting: {
        ...base.meeting,
        accountId: zoom,
        externalId: "zoom-weekly",
        title: "Weekly sync (Zoom)",
        joinUrl: ZOOM,
        startedAt: at("2026-11-10T10:02:00Z"),
        endedAt: at("2026-11-10T10:50:00Z"),
      },
    })
    const alone = await store.meetings.saveMeeting({
      ...base,
      transcripts: [],
      meeting: {
        ...base.meeting,
        accountId: zoom,
        externalId: "zoom-adhoc",
        title: "Ad hoc",
        joinUrl: "https://us02web.zoom.us/j/987654321",
        startedAt: at("2026-11-12T15:00:00Z"),
        endedAt: at("2026-11-12T15:30:00Z"),
        series: { ...base.meeting.series, externalId: "adhoc" },
      } as typeof base.meeting,
    })
    return { store, zoom, zoomed, alone, base, calendar: calendar?.id as number }
  }
  const month = "started_at:[2026-11-01 TO 2026-12-01}"

  it("joins a calendar event and its Zoom meeting on the same room and time, and no other occurrence", async () => {
    const { store, zoom, zoomed } = await setup()
    const { request } = meetingListRequest(month, page)
    const found = await listMeetingEntries(store, request)
    for (const item of found.items) expect(v.safeParse(meetingEntry, item).issues).toBeUndefined()
    expect(found.items.map(({ title, kind }) => `${kind}:${title}`)).toEqual([
      "event:Weekly sync next",
      "meeting:Ad hoc",
      "event:Lunch",
      "meeting:Weekly sync",
      "call:Call with Bob",
    ])
    expect(found.total).toEqual({ value: 5, relation: "eq" })
    const weekly = found.items.find(({ title }) => title === "Weekly sync")
    expect(weekly).toMatchObject({
      meetings: [`meeting:${zoom}/${zoomed.meeting.id}`],
      has_transcript: true,
      participants_count: 1,
      url: expect.stringContaining("zoom.us"),
      timezone: "UTC",
    })
    expect(weekly?.links).toHaveLength(1)
    expect(weekly?.sources.map(({ source, via }) => `${via}:${source}`)).toEqual([
      "calendar:google-calendar:ana",
      "meeting:zoom:ana",
    ])
    expect(found.items.find(({ title }) => title === "Weekly sync next")?.meetings).toEqual([])
  })

  it("reads the last 30 days and the next 7 without a window, and narrows by kind, source and transcript", async () => {
    const { store } = await setup()
    const titles = async (words: string) =>
      (await listMeetingEntries(store, meetingListRequest(words, page).request)).items.map(({ title }) => title)
    expect(await titles("")).not.toContain("Old review")
    expect(await titles(`${month} kind:call`)).toEqual(["Call with Bob"])
    expect(await titles(`${month} kind:call kind:event`)).toEqual(["Weekly sync next", "Lunch", "Call with Bob"])
    expect(await titles(`${month} source:zoom`)).toEqual(["Ad hoc", "Weekly sync"])
    expect(await titles(`${month} has_transcript:true`)).toEqual(["Weekly sync"])
    expect(await titles(`${month} weekly`)).toEqual(["Weekly sync next", "Weekly sync"])
    expect(await titles("started_at:[2026-11-10 TO 2026-11-11}")).toEqual(["Weekly sync"])
    const window = { ...page, from: "2026-11-09T08:05:00+00:00", to: "2026-11-11T12:30:00Z", order: "start" as const }
    expect(
      (await listMeetingEntries(store, meetingListRequest("", window).request)).items.map(({ title }) => title),
    ).toEqual(["Call with Bob", "Weekly sync", "Lunch"])
    expect(() => meetingListRequest("", { ...page, from: "2026-11-09" })).toThrow(/offset/u)
  })

  it("shows a row with its transcript lines, by its event or by its meeting", async () => {
    const { store, zoom, zoomed } = await setup()
    const byMeeting = await showMeetingEntry(store, `meeting:${zoom}/${zoomed.meeting.id}`, { offset: 0, limit: 1 })
    expect(v.safeParse(meetingEntryDetails, byMeeting).issues).toBeUndefined()
    expect(byMeeting.ref).toMatch(/^event:/u)
    expect(byMeeting.transcript).toMatchObject({ offset: 0, lines: [{ position: 0, speaker: "Alice Example" }] })
    expect((await showMeetingEntry(store, byMeeting.ref, { offset: 0, limit: 1 })).meetings).toEqual(byMeeting.meetings)
    await expect(
      showMeetingEntry(store, `meeting:${zoom + 50}/${zoomed.meeting.id}`, { offset: 0, limit: 1 }),
    ).rejects.toMatchObject({
      code: "not_found",
    })
  })

  it("gives each calendar copy's page, the answers to the invitation, the series' rule and the Drive files", async () => {
    const { store, calendar, zoom, zoomed } = await setup()
    const invited = {
      externalId: "standup",
      kind: "series" as const,
      status: "confirmed" as const,
      title: "Standup",
      startsAt: at("2026-11-02T09:00:00Z"),
      endsAt: at("2026-11-02T09:15:00Z"),
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"],
    }
    await store.calendar.saveEntries(
      calendar,
      [
        invited,
        entry("standup_20261111", {
          seriesExternalId: "standup",
          kind: "occurrence",
          originalStartsAt: at("2026-11-11T09:00:00Z"),
          title: "Standup",
          startsAt: at("2026-11-11T09:00:00Z"),
          endsAt: at("2026-11-11T09:15:00Z"),
          url: "https://www.google.com/calendar/event?eid=c3RhbmR1cA",
          ownResponse: "tentative",
          conference: "Google Meet",
          participants: [
            { email: "bob@example.org", name: "Bob", response: "accepted", organizer: true },
            { email: "cleo@example.org", name: "Cleo", response: "declined" },
          ],
          attachments: [{ fileId: "agenda-1", title: "Agenda" }],
        }),
        entry("Unsafe", {
          url: "javascript:alert(1)",
          startsAt: at("2026-11-13T09:00:00Z"),
          endsAt: at("2026-11-13T10:00:00Z"),
        }),
      ],
      1,
    )
    const rows = (await listMeetingEntries(store, meetingListRequest(month, page).request)).items
    const standup = rows.find(({ title }) => title === "Standup")
    expect(v.safeParse(meetingEntry, standup).issues).toBeUndefined()
    expect(standup).toMatchObject({
      recurrence: "RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
      series_id: expect.stringMatching(/^\d+$/u),
      sources: [
        {
          via: "calendar",
          page_url: "https://www.google.com/calendar/event?eid=c3RhbmR1cA",
          own_response: "tentative",
          conference: "Google Meet",
        },
      ],
      participants: [
        { name: "Bob", response: "accepted", organizer: true },
        { name: "Cleo", response: "declined" },
      ],
    })
    expect(rows.find(({ title }) => title === "Unsafe")?.sources[0]?.page_url).toBeNull()
    const zoomRow = rows.find(({ meetings }) => meetings.includes(`meeting:${zoom}/${zoomed.meeting.id}`))
    expect(zoomRow?.sources.find(({ via }) => via === "meeting")).toMatchObject({ page_url: null, own_response: null })
    expect(zoomRow).toMatchObject({ series_id: null, recurrence: null })

    const shown = await showMeetingEntry(store, standup?.ref as string, { offset: 0, limit: 1 })
    expect(v.safeParse(meetingEntryDetails, shown).issues).toBeUndefined()
    expect(shown.attachments).toEqual([{ file_id: "agenda-1", title: "Agenda", document: null }])
  })

  it("ties Meet's notes to their event by the event's Drive attachment, whichever syncs first", async () => {
    const { store, calendar } = await setup()
    const meet = (externalId: string, fileId: string) =>
      entry(externalId, {
        joinUrl: "https://meet.google.com/abc-defg-hij",
        startsAt: at("2026-11-12T09:00:00Z"),
        endsAt: at("2026-11-12T09:30:00Z"),
        attachments: [{ fileId, title: `${externalId} - Notes by Gemini` }],
      })
    const drive = String(await store.accounts.saveAccount({ provider: "google-drive", account: "ana" }, { name: null }))
    const notes = (fileId: string, title: string) =>
      store.notes.saveFileNote({
        folderId: drive,
        path: `${fileId}.md`,
        title,
        text: "Summary of an invented meeting",
        frontMatter: { source: "google-drive", fileId },
      })
    const early = await notes("notes-1", "Design review - Notes by Gemini")
    await store.calendar.saveEntries(calendar, [meet("Design review", "notes-1")], 1)
    await store.calendar.saveEntries(calendar, [meet("Retro", "notes-2")], 1)
    const late = await notes("notes-2", "Retro - Notes by Gemini")

    const rows = (await listMeetingEntries(store, meetingListRequest(`${month} kind:event`, page).request)).items
    for (const [title, note] of [
      ["Design review", early.note],
      ["Retro", late.note],
    ] as const) {
      const row = rows.find((one) => one.title === title)
      expect(row?.documents).toMatchObject([{ ref: `document:${note.id}`, title: `${title} - Notes by Gemini` }])
      const shown = await showDocument(store, `document:${note.id}`, { offset: 0, limit: 1 })
      expect(shown.events).toMatchObject([{ ref: row?.ref, title }])
    }
  })

  it("keeps a meeting that runs into the window on its event's row, though the event ended before it", async () => {
    const { store, zoom, base } = await setup()
    await store.meetings.saveMeeting({
      ...base,
      transcripts: [],
      meeting: {
        ...base.meeting,
        accountId: zoom,
        externalId: "zoom-overrun",
        title: "Weekly sync, part two",
        joinUrl: ZOOM,
        startedAt: at("2026-11-10T10:55:00Z"),
        endedAt: at("2026-11-10T11:30:00Z"),
      },
    })
    const window = { ...page, from: "2026-11-10T11:10:00Z", to: "2026-11-10T12:00:00Z" }
    const found = await listMeetingEntries(store, meetingListRequest("", window).request)
    expect(found.items.map(({ title, meetings }) => `${title}:${meetings.length}`)).toEqual(["Weekly sync:2"])
    expect(found.total.value).toBe(1)
  })

  it("puts a meeting on the event the owner linked it to, over a calendar event in the same room", async () => {
    const { store, zoomed } = await setup()
    const db = await openCache(paths.get(store) as string)
    opened.push(db)
    const own = Number(
      db
        .prepare(
          "INSERT INTO events (title, starts_at, ends_at, origin, created_at, updated_at) " +
            "VALUES ('Owner made', ?, ?, 'owner', 1, 1) RETURNING id",
        )
        .get(at("2026-11-10T10:00:00Z"), at("2026-11-10T11:00:00Z"))?.id,
    )
    await store.meetings.linkMeeting(zoomed.meeting.id, own, NOW, "owner")
    const found = await listMeetingEntries(store, meetingListRequest(month, page).request)
    const meetings = (title: string) => found.items.find((item) => item.title === title)?.meetings.length
    expect([meetings("Owner made"), meetings("Weekly sync")]).toEqual([1, 0])
    expect((await showMeetingEntry(store, `event:${own}`, { offset: 0, limit: 1 })).meetings).toHaveLength(1)
  })

  it("counts only the findings the owner has not decided yet as pending", async () => {
    const { store, zoom, zoomed } = await setup()
    const account = { provider: "zoom", account: "ana" }
    const project = await store.knowledge.addProject({ name: "Invented Harbour", key: "IHB" })
    await store.knowledge.linkMeetingProject(account, String(zoomed.meeting.id), project.id, { by: "owner" })
    const transcript = zoomed.transcripts[0]
    if (!transcript?.rows[0]) throw new Error("the sample meeting has a transcript")
    const cue = cueEvidence(zoom, zoomed.meeting.id, transcript.transcript, transcript.rows[0])
    const evidence = [{ reference: cue.reference, fingerprint: cue.fingerprint }]
    const input: MeetingFindingsInput = {
      schemaVersion: 1,
      key: "listing-batch",
      extractor: "synthetic",
      findings: [
        { id: "decision", kind: "fact", type: "decision", statement: "Ship it", project: project.ref, evidence },
        {
          id: "followup",
          kind: "task",
          type: "chore",
          title: "Write the note",
          reason: "Agreed",
          commitment: "inferred",
          project: project.ref,
          evidence,
        },
      ],
    }
    const batch = await store.meetingFindings.stage(account, input, { bot: "listing-test", model: "synthetic" })
    const weekly = async () =>
      (await listMeetingEntries(store, meetingListRequest(month, page).request)).items.find(
        ({ title }) => title === "Weekly sync",
      )
    expect((await weekly())?.pending_findings).toBe(2)
    await store.meetingFindings.review(account, batch.id, {
      fingerprint: batch.fingerprint,
      accept: ["decision"],
      by: "owner",
    })
    expect((await weekly())?.pending_findings).toBe(1)
    const shown = await showMeetingEntry(store, (await weekly())?.ref as string, { offset: 0, limit: 1 })
    expect(shown.findings).toEqual([{ id: batch.id, status: "proposed", findings: 2, pending: 1 }])
  })
})
