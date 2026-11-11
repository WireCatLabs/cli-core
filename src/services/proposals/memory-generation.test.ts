import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { documentIngestion, type SourceContent, type SourceFile } from "../../documents/index.js"
import { formatLocator } from "../../domain/locator.js"
import { sampleMeeting } from "../../meetings/testing/index.js"
import { type AccountKey, type MessageStore, openStore } from "../../store/index.js"
import { cueEvidence } from "../meeting-evidence.js"
import { proposalRegistry } from "./registry.js"

const DRIVE: AccountKey = { provider: "google-drive", account: "owner@example.com" }
const MAIL: AccountKey = { provider: "email", account: "owner@example.com" }
const MEETINGS: AccountKey = { provider: "example", account: "synthetic" }
const agent = { bot: "triage", model: "synthetic" }
const COMMITMENT = "I will send the signed lease by Friday."
const DECISION = "We decided to move the launch to March."

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const driveFile: SourceFile = {
  id: "sales-playbook",
  name: "Sales Playbook",
  parents: ["root"],
  mime: "text/plain",
  url: "https://example.invalid/sales-playbook",
  trashed: false,
  canDownload: true,
  version: "7",
}
const driveContent: SourceContent<SourceFile> = {
  metadata: driveFile,
  text: "How we qualify a lead.",
  markdown: "How we qualify a lead.",
  tabs: [],
}

const importDriveFile = async (store: MessageStore) => {
  await store.accounts.saveAccount(DRIVE, { name: "Google Drive" })
  await store.people.savePeople(DRIVE, [
    { id: "g-owner", name: "Olga Owner", email: "olga@example.com" },
    { id: "g-editor", name: "Eli Editor", email: "eli@example.com" },
  ])
  const ingestion = documentIngestion(store, {
    provider: DRIVE.provider,
    externalId: (id) => `${id}.md`,
    catalogInput: (item: SourceFile) => ({ externalId: `${item.id}.md`, kind: "file", name: item.name, parents: [] }),
    frontMatter: () => ({
      owners: [{ id: "g-owner", name: "Olga Owner" }],
      lastModifiedBy: { id: "g-editor", name: "Eli Editor" },
    }),
    observed: async (_principal, _file, documentId) => {
      const owner = await store.people.personOf({ provider: DRIVE.provider, id: "g-owner" })
      await store.notes.replaceFileLinks(documentId, [
        {
          kind: "related-to",
          to: `person:${owner?.uid}`,
          role: "owner",
          evidence: "Google Drive lists this person as the document's owner",
          provenance: "google-drive:files.get",
          confirmed: false,
        },
      ])
    },
  })
  return ingestion.save(DRIVE.account, driveContent, "hash-one")
}

const importMailThread = async (store: MessageStore) => {
  const accountId = await store.accounts.saveAccount(MAIL, { name: null })
  const id = "<lease-1@example.com>"
  await store.mail.saveThread({
    accountId,
    externalId: "t-lease",
    now: Date.now(),
    emails: [
      {
        externalId: id,
        subject: "Lease",
        from: { address: "ann@example.com", name: "Ann Example" },
        to: [{ address: MAIL.account, name: "Owner" }],
        sentAt: Date.now(),
        receivedAt: Date.now(),
        bodyText: COMMITMENT,
      },
    ],
  })
  const marks = await store.mail.emailMarks(accountId, [id])
  return {
    reference: formatLocator({ provider: "email", account: MAIL.account, chat: "t-lease", message: id }),
    fingerprint: marks.get(id)?.fingerprint as string,
  }
}

const importMeeting = async (store: MessageStore) => {
  const seed = sampleMeeting()
  seed.meeting.accountId = await store.accounts.saveAccount(MEETINGS, { name: "Synthetic" })
  seed.transcripts[0].rows[0].text = DECISION
  const meeting = await store.meetings.saveMeeting(seed)
  const project = await store.knowledge.addProject({ name: "Harbour Launch", key: "HBL" })
  await store.knowledge.linkMeetingProject(MEETINGS, String(meeting.meeting.id), project.id, { by: "owner" })
  const transcript = meeting.transcripts[0]
  if (!transcript?.rows[0]) throw new Error("Missing synthetic cue")
  const cue = cueEvidence(seed.meeting.accountId, meeting.meeting.id, transcript.transcript, transcript.rows[0])
  return { project: project.ref, evidence: { reference: cue.reference, fingerprint: cue.fingerprint } }
}

const fixture = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "memory-generation-")), "store.db") })
  stores.push(store)
  const document = await importDriveFile(store)
  const mail = await importMailThread(store)
  const meeting = await importMeeting(store)
  const registry = proposalRegistry(store)
  const waiting = async () => (await registry.list({ limit: 50, offset: 0 })).items
  return { store, document, mail, meeting, registry, waiting }
}

describe("what the memory review holds", () => {
  it("holds nothing after a Drive file, a mail thread and a meeting are only imported", async () => {
    const f = await fixture()

    expect(await f.waiting()).toEqual([])
    expect((await f.store.knowledge.listRelations({ standing: "proposed" })).items).toEqual([])
    expect((await f.store.memories.list({ limit: 10 })).items.length).toBe(0)
    expect((await f.store.facts.list({ limit: 10 })).items.length).toBe(0)
  })

  it("keeps a file's owner as the account's report, read on the document and never waiting", async () => {
    const f = await fixture()

    expect((await f.store.knowledge.listRelations({ about: f.document })).items).toMatchObject([
      { role: "owner", standing: "reported", confirmed: false },
    ])
    expect((await f.store.notes.links({ from: f.document, role: "last-editor" })).length).toBe(0)
  })

  it("asks about a commitment read in mail and a decision heard in a meeting, and records them once accepted", async () => {
    const f = await fixture()
    const mailBatch = await f.store.mailFindings.stage(
      MAIL,
      {
        schemaVersion: 1,
        key: "mail-triage:1",
        extractor: "synthetic",
        findings: [
          {
            id: "lease",
            kind: "task",
            type: "chore",
            title: "Expect the signed lease from Ann by Friday",
            reason: "Ann commits to it in her email",
            commitment: "explicit",
            evidence: [f.mail],
          },
        ],
      },
      agent,
    )
    const meetingBatch = await f.store.meetingFindings.stage(
      MEETINGS,
      {
        schemaVersion: 1,
        key: "meeting:1",
        extractor: "synthetic",
        findings: [
          {
            id: "launch",
            kind: "fact",
            type: "decision",
            statement: "The launch moves to March",
            project: f.meeting.project,
            evidence: [f.meeting.evidence],
          },
        ],
      },
      agent,
    )

    expect(await f.waiting()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: mailBatch.id,
          kind: "mail_findings",
          parts: [expect.objectContaining({ id: "lease" })],
        }),
        expect.objectContaining({
          id: meetingBatch.id,
          kind: "meeting_findings",
          parts: [expect.objectContaining({ id: "launch" })],
        }),
      ]),
    )
    expect(await f.waiting()).toHaveLength(2)

    await f.registry.decide([mailBatch.id, meetingBatch.id], { confirm: true, by: "owner" })

    expect(await f.waiting()).toEqual([])
    expect((await f.store.tasks.find({ status: "open", limit: 5 })).items).toMatchObject([
      { title: "Expect the signed lease from Ann by Friday" },
    ])
    expect((await f.store.facts.list({ limit: 5 })).items).toMatchObject([
      { type: "decision", statement: "The launch moves to March" },
    ])
  })
})
