import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"
import { documentIngestion, type SourceFile } from "../../documents/index.js"
import { type MeetingDocumentInput, meetingDetails, meetingDetailsAnswer, pull } from "../../meetings/index.js"
import { fakeMeetingSource } from "../../meetings/testing/index.js"
import { type MessageStore, openStore } from "../store.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const fixture = async () => {
  const folder = mkdtempSync(join(tmpdir(), "meeting-documents-"))
  const path = join(folder, "wirecat.db")
  const store = await openStore({ path, env: { MESSAGING_STORE: path } })
  stores.push(store)
  const accountId = await store.accounts.saveAccount(
    { provider: "google-meet", account: "meet-profile:alice" },
    { name: "Invented" },
  )
  return { store, accountId }
}

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

const importDoc = async (store: MessageStore, fileId: string, principal = "owner@example.invalid") => {
  const file: SourceFile = {
    id: fileId,
    name: `Invented ${fileId}`,
    mime: "application/vnd.google-apps.document",
    parents: [],
    url: `https://docs.google.com/document/d/${fileId}`,
    trashed: false,
    canDownload: true,
  }
  const text = `invented text of ${fileId}`
  const ref = await drive(store).save(principal, { metadata: file, text, markdown: text, tabs: [] }, text)
  return Number(ref.slice("document:".length))
}

const pullWith = async (
  store: MessageStore,
  accountId: number,
  documents: () => Promise<MeetingDocumentInput[] | null>,
  now = 4000,
) => {
  const report = await pull(fakeMeetingSource({ provider: "google-meet", name: "meet", documents }), store.meetings, {
    accountId,
    now,
  })
  const [meeting] = await store.meetings.meetings({ accountId })
  if (!meeting) throw new Error("the pull saved no meeting")
  return { report, meetingId: meeting.id }
}

const shown = async (store: MessageStore, meetingId: number) =>
  v.parse(meetingDetails, (await meetingDetailsAnswer(store.meetings, meetingId)).item).documents

const transcript = { fileId: "doc-t", role: "transcript", title: "Invented call – Transcript" } as const
const notes = { fileId: "doc-n", role: "notes" } as const

describe("a meeting's Drive documents", () => {
  it("links each listed file whichever arrives first, and `meetings show` names the document once stored", async () => {
    const { store, accountId } = await fixture()
    const early = await importDoc(store, "doc-t")
    const { report, meetingId } = await pullWith(store, accountId, async () => [transcript, notes])
    expect(report.warnings).toEqual([])
    expect(await shown(store, meetingId)).toEqual([
      { file_id: "doc-t", role: "transcript", title: "Invented call – Transcript", document: `document:${early}` },
      { file_id: "doc-n", role: "notes", title: null, document: null },
    ])
    const late = await importDoc(store, "doc-n")
    expect((await shown(store, meetingId))[1]).toMatchObject({ document: `document:${late}` })
    expect(await store.meetings.documentMeetings([early, late])).toEqual(
      new Map([
        [early, { meetingId, accountId, role: "transcript" }],
        [late, { meetingId, accountId, role: "notes" }],
      ]),
    )
    expect(await store.meetings.transcriptMeetings([early, late])).toEqual(new Map([[early, meetingId]]))
  })

  it("a replay adds no second link and retitles; a list without a file, empty or failed keeps its link", async () => {
    const { store, accountId } = await fixture()
    const { meetingId } = await pullWith(store, accountId, async () => [transcript, notes])
    await pullWith(store, accountId, async () => [{ ...transcript, title: "Renamed" }], 5000)
    await pullWith(store, accountId, async () => [], 6000)
    await pullWith(store, accountId, async () => null, 7000)
    const failed = await pullWith(
      store,
      accountId,
      async () => {
        throw new Error("Meet answered 503")
      },
      8000,
    )
    expect(failed.report.warnings).toEqual([
      { externalId: "example-occurrence", message: "documents: Meet answered 503" },
    ])
    expect((await shown(store, meetingId)).map(({ file_id, title }) => [file_id, title])).toEqual([
      ["doc-t", "Renamed"],
      ["doc-n", null],
    ])
  })

  it("a source without `documents` leaves `meetings show` with none", async () => {
    const { store, accountId } = await fixture()
    const report = await pull(fakeMeetingSource({ provider: "google-meet", name: "meet" }), store.meetings, {
      accountId,
      now: 4000,
    })
    expect(report.meetings).toBe(1)
    const [meeting] = await store.meetings.meetings({ accountId })
    expect(await shown(store, meeting?.id ?? 0)).toEqual([])
  })

  it("a deleted document, or a file two Drive profiles hold, shows no document", async () => {
    const { store, accountId } = await fixture()
    const both = await importDoc(store, "doc-n")
    await importDoc(store, "doc-n", "other@example.invalid")
    const { meetingId } = await pullWith(store, accountId, async () => [transcript, notes])
    expect(both).toBeGreaterThan(0)
    const stored = await importDoc(store, "doc-t")
    expect((await shown(store, meetingId))[0]?.document).toBe(`document:${stored}`)
    await drive(store).remove("owner@example.invalid", "doc-t")
    expect((await shown(store, meetingId)).map(({ document }) => document)).toEqual([null, null])
  })

  it("a new transcript version replaces only the old version's link, never a listed one", async () => {
    const { store, accountId } = await fixture()
    const { meetingId } = await pullWith(store, accountId, async () => [transcript])
    const version = (contentHash: string, driveFileId: string, now: number) =>
      store.meetings.saveMeeting({
        meeting: {
          accountId,
          externalId: "example-occurrence",
          title: "Example planning",
          description: null,
          location: null,
          joinUrl: null,
          startedAt: 1000,
          endedAt: 2000,
          durationMs: 1000,
          timezone: null,
          hostIdentityId: null,
          metadata: null,
          deletedAt: null,
        },
        transcripts: [
          {
            source: "meet-version",
            format: null,
            language: null,
            contentHash,
            externalCreatedAt: null,
            metadata: null,
            deletedAt: null,
            driveFileId,
            rows: [],
          },
        ],
        now,
      })
    await version("v1", "doc-v1", 5000)
    await version("v2", "doc-v2", 6000)
    expect((await shown(store, meetingId)).map(({ file_id }) => file_id)).toEqual(["doc-t", "doc-v2"])
  })
})
