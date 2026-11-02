import { createHash } from "node:crypto"
import { existsSync, linkSync, mkdtempSync, readFileSync, statSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { rollBackTo } from "../../testing/older-store.js"
import { openCache } from "../open.js"
import * as writes from "../sqlite/document-transfer/apply.js"
import { openStore } from "../store.js"
import { applyDocumentTransfer, previewDocumentTransfer } from "./index.js"

const collection = "example-documents:synthetic-owner"
const handles: { close(): unknown }[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const handle of handles.splice(0)) await handle.close()
})
const open = async (path: string) => {
  const store = await openStore({ path, now: () => Date.parse("2026-10-17T00:00:00Z") })
  handles.push(store)
  return store
}
const sql = async (path: string) => {
  const db = await openCache(path)
  handles.push(db)
  return db
}
const seed = async (name = collection) => {
  const root = mkdtempSync(join(tmpdir(), "annotation-transfer-"))
  const source = join(root, "source.db"),
    destination = join(root, "destination.db")
  const store = await openStore({ path: source, now: () => Date.parse("2026-10-16T00:00:00Z") })
  const folder = await store.notes.addFolder({ name })
  const first = {
    folderId: folder.id,
    path: "budget.md",
    title: "Synthetic budget",
    text: "Budget version one",
    contentHash: "h1",
  }
  const { note: doc } = await store.notes.saveFileNote(first)
  await store.notes.saveFileNote({ ...first, text: "Budget version two", contentHash: "h2" })
  const note = await store.notes.addNote({ text: "Initial owner note", about: [doc.ref] })
  await store.notes.editNote(note.ref, "Reviewed owner note", note.revision)
  await store.knowledge.addTags(null, { type: "document", id: doc.id }, ["transfer-proof"])
  await store.knowledge.addTags(null, { type: "note", id: note.id }, ["retained-note"])
  const tag = (await store.knowledge.vocabulary()).entries.find((item) => item.name === "transfer-proof")
  if (!tag) throw new Error("synthetic tag missing")
  await store.knowledge.addVocabularyAlias({ kind: "tag", id: tag.id }, "budget-evidence")
  const memory = await store.memories.add({
    kind: "summary",
    body: "Earlier summary",
    scope: "work",
    evidence: [doc.ref],
    subject: doc.ref,
    author: { bot: "synthetic-reader", model: "synthetic-model" },
    status: "confirmed",
  })
  const nextMemory = await store.memories.add({
    kind: "summary",
    body: "Later summary",
    scope: "work",
    evidence: [doc.ref, note.ref],
    subject: doc.ref,
    author: { bot: "synthetic-reader", model: "synthetic-model" },
    status: "confirmed",
    supersedes: memory.ref,
  })
  await store.memories.markStale(nextMemory.ref)
  const fact = await store.facts.add({
    type: "decision",
    statement: "Earlier budget",
    by: "owner",
    subject: doc.ref,
    evidence: [doc.ref],
    occurredAt: "2026-10-15T00:00:00Z",
  })
  const nextFact = await store.facts.add({
    type: "decision",
    statement: "Later budget",
    by: { bot: "synthetic-reader", model: "synthetic-model" },
    subject: doc.ref,
    evidence: [doc.ref, note.ref],
    supersedes: fact.ref,
    scope: "work",
  })
  await store.facts.accept(nextFact.ref, "owner")
  await store.facts.reverse(nextFact.ref)
  await store.notes.addLink({
    from: doc.ref,
    to: note.ref,
    kind: "links-to",
    origin: "owner",
    anchor: "budget",
    evidence: "owner reviewed",
    provenance: "synthetic-provenance",
  })
  await store.notes.addLink({
    from: doc.ref,
    kind: "links-to",
    targetText: "Unknown synthetic colleague",
    origin: "owner",
  })
  await store.close()
  return {
    root,
    source,
    destination,
    doc,
    note,
    memory,
    nextMemory,
    fact,
    nextFact,
    options: { source, destination, collection: name },
  }
}

describe("provider-neutral document annotation transfer", () => {
  it("previews without creating a destination or changing an older source", async () => {
    const f = await seed()
    const db = await openCache(f.source)
    rollBackTo(db, 21)
    db.close()
    const before = readFileSync(f.source),
      modified = statSync(f.source).mtimeMs
    const preview = await previewDocumentTransfer(f.options)
    expect(preview).toMatchObject({
      ready: true,
      already_transferred: false,
      missing_bindings: [],
      conflicts: [],
      counts: { documents: 1, notes: 1, memories: 2, facts: 2, tags: 2 },
    })
    expect(preview.counts.links).toBeGreaterThanOrEqual(8)
    expect(existsSync(f.destination)).toBe(false)
    expect(readFileSync(f.source).equals(before)).toBe(true)
    expect(statSync(f.source).mtimeMs).toBe(modified)
    expect(JSON.stringify(preview)).not.toContain("Reviewed owner note")
  })

  it("copies a collection from a store before version 32 into a vault account, with a files row per document", async () => {
    const f = await seed()
    const db = await openCache(f.source)
    rollBackTo(db, 21)
    expect(db.prepare("SELECT provider FROM accounts WHERE name = ?").get(collection)).toEqual({ provider: "folder" })
    db.close()
    const preview = await previewDocumentTransfer(f.options)
    await applyDocumentTransfer({ ...f.options, expected_fingerprint: preview.fingerprint })
    const copied = await sql(f.destination)
    expect(
      copied
        .prepare("SELECT a.provider, f.path FROM files f JOIN accounts a ON a.id = f.account_id WHERE a.name = ?")
        .all(collection),
    ).toEqual([{ provider: "obsidian", path: "budget.md" }])
  })

  it("remaps collisions, histories, evidence, statuses, authors and both link directions without changing the source", async () => {
    const f = await seed()
    const other = await open(f.destination)
    const folder = await other.notes.addFolder({ name: "unrelated-provider:other" })
    const unrelated = (
      await other.notes.saveFileNote({
        folderId: folder.id,
        path: "other.md",
        title: "Other",
        text: "Unrelated evidence",
      })
    ).note
    const unrelatedNote = await other.notes.addNote({ text: "Keep this note", about: [unrelated.ref] })
    await other.memories.add({
      kind: "summary",
      body: "Unrelated memory",
      scope: "personal",
      evidence: [unrelated.ref],
      author: "owner",
    })
    await other.facts.add({ type: "fact", statement: "Unrelated fact", by: "owner", evidence: [unrelated.ref] })
    const before = readFileSync(f.source)
    const preview = await previewDocumentTransfer(f.options)
    const receipt = await applyDocumentTransfer({ ...f.options, expected_fingerprint: preview.fingerprint })
    const doc = receipt.references[f.doc.ref] as string,
      note = receipt.references[f.note.ref] as string
    expect(doc).not.toBe(unrelated.ref)
    expect(note).not.toBe(unrelatedNote.ref)
    expect(await other.notes.note(doc)).toMatchObject({ text: "Budget version two", revision: 2 })
    expect(await other.notes.note(note)).toMatchObject({ text: "Reviewed owner note", revision: 2 })
    expect(await other.notes.noteTags(doc)).toMatchObject([{ tag: "transfer-proof" }])
    expect(await other.notes.noteTags(note)).toMatchObject([{ tag: "retained-note" }])
    expect((await other.knowledge.resolveVocabulary("budget-evidence")).matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "transfer-proof" })]),
    )
    const older = await other.memories.get(receipt.references[f.memory.ref] as string)
    const newer = await other.memories.get(receipt.references[f.nextMemory.ref] as string)
    expect(older).toMatchObject({
      status: "superseded",
      scope: "work",
      author: { type: "bot", name: "synthetic-reader" },
      model: "synthetic-model",
    })
    expect(newer).toMatchObject({
      status: "stale",
      scope: "work",
      supersedes: older.ref,
      subject: doc,
      evidence: [doc, note],
    })
    expect(await other.facts.get(receipt.references[f.fact.ref] as string)).toMatchObject({
      status: "superseded",
      subject: doc,
      occurredAt: "2026-10-15T00:00:00.000Z",
    })
    expect(await other.facts.get(receipt.references[f.nextFact.ref] as string)).toMatchObject({
      status: "reversed",
      supersedes: receipt.references[f.fact.ref],
      evidence: [doc, note],
      confirmedBy: { type: "person" },
    })
    expect(await other.notes.links({ from: doc })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to: note,
          anchor: "budget",
          evidence: "owner reviewed",
          provenance: "synthetic-provenance",
        }),
        expect.objectContaining({ to: null, targetText: "Unknown synthetic colleague" }),
      ]),
    )
    expect(await other.notes.links({ to: doc })).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: newer.ref, kind: "evidence" })]),
    )
    expect(await other.notes.note(unrelated.ref)).toMatchObject({ text: "Unrelated evidence" })
    expect(await other.notes.note(unrelatedNote.ref)).toMatchObject({ text: "Keep this note" })
    const db = await sql(f.destination)
    expect(
      db.prepare("SELECT body FROM document_revisions WHERE document_id=?").all(Number(doc.split(":")[1])),
    ).toEqual([{ body: "Budget version one" }])
    expect(db.prepare("SELECT body FROM note_revisions WHERE note_id=?").all(Number(note.split(":")[1]))).toEqual([
      { body: "Initial owner note" },
    ])
    expect(db.prepare("SELECT token_digest,metadata FROM bots WHERE name='synthetic-reader'").get()).toEqual({
      token_digest: null,
      metadata: null,
    })
    expect(readFileSync(f.source).equals(before)).toBe(true)
  })

  it("rolls back an interrupted copy and retries without duplicate annotations or relationships", async () => {
    const f = await seed()
    await open(f.destination)
    const db = await sql(f.destination)
    db.exec(
      "CREATE TRIGGER synthetic_transfer_failure BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT,'synthetic interruption'); END",
    )
    const first = await previewDocumentTransfer(f.options)
    await expect(applyDocumentTransfer({ ...f.options, expected_fingerprint: first.fingerprint })).rejects.toThrow(
      "synthetic interruption",
    )
    for (const table of ["documents", "notes", "memories", "facts", "document_annotation_transfers"])
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0)
    db.exec("DROP TRIGGER synthetic_transfer_failure")
    const preview = await previewDocumentTransfer(f.options)
    const copied = await applyDocumentTransfer({ ...f.options, expected_fingerprint: preview.fingerprint })
    const rows = () =>
      ["documents", "notes", "memories", "facts", "links", "taggings", "document_annotation_transfers"].map(
        (table) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n,
      )
    const before = rows()
    const again = await previewDocumentTransfer(f.options)
    expect(again).toMatchObject({ already_transferred: true, ready: true })
    const replayed = await applyDocumentTransfer({ ...f.options, expected_fingerprint: again.fingerprint })
    expect(replayed.references).toEqual(copied.references)
    expect(rows()).toEqual(before)
  })

  it("blocks unresolved project links and maps explicit decisions without trusting colliding row ids", async () => {
    const f = await seed()
    const source = await open(f.source)
    const project = await source.knowledge.addProject({ name: "Synthetic source project" })
    await source.notes.addLink({ from: project.ref, to: f.doc.ref, kind: "links-to", origin: "owner" })
    const target = await open(f.destination)
    const collision = await target.knowledge.addProject({ name: "Unrelated colliding project" })
    const selected = await target.knowledge.addProject({ name: "Explicitly selected project" })
    expect(collision.ref).toBe(project.ref)
    const blocked = await previewDocumentTransfer(f.options)
    expect(blocked).toMatchObject({ ready: false, missing_bindings: [project.ref] })
    await expect(
      applyDocumentTransfer({ ...f.options, expected_fingerprint: blocked.fingerprint }),
    ).rejects.toMatchObject({ code: "configuration_error" })
    const options = { ...f.options, bindings: { [project.ref]: selected.ref } }
    const preview = await previewDocumentTransfer(options)
    expect(preview.ready).toBe(true)
    const receipt = await applyDocumentTransfer({ ...options, expected_fingerprint: preview.fingerprint })
    expect(await target.notes.links({ to: receipt.references[f.doc.ref] })).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: selected.ref })]),
    )
    expect(await target.notes.links({ from: collision.ref })).toEqual([])
  })

  it("refuses a changed source preview before creating the destination", async () => {
    const f = await seed()
    const preview = await previewDocumentTransfer(f.options)
    const source = await open(f.source)
    await source.notes.addNote({ text: "Added after preview", about: [f.doc.ref] })
    await expect(
      applyDocumentTransfer({ ...f.options, expected_fingerprint: preview.fingerprint }),
    ).rejects.toMatchObject({ code: "validation_error" })
    expect(existsSync(f.destination)).toBe(false)
  })

  it("keeps observed people by provider identity, without merging a matching display name or copying bot credentials", async () => {
    const f = await seed()
    const source = await open(f.source)
    const key = { provider: "example-drive", account: "synthetic-owner" }
    await source.accounts.saveAccount(key, { name: "Synthetic provider" })
    await source.people.savePeople(key, [{ id: "editor-42", name: "Alex Example" }])
    const editor = await source.people.personOf({ provider: key.provider, id: "editor-42" })
    expect(editor).toBeDefined()
    await source.notes.addLink({
      from: f.doc.ref,
      to: `person:${editor?.uid}`,
      kind: "links-to",
      role: "last-editor",
      origin: "file",
    })
    const sourceDb = await sql(f.source)
    sourceDb
      .prepare(
        "UPDATE bots SET token_digest='synthetic-private-value', metadata='synthetic-private-metadata' WHERE name='synthetic-reader'",
      )
      .run()
    const destination = await open(f.destination)
    const unrelated = { provider: "example-chat", account: "synthetic-other" }
    await destination.accounts.saveAccount(unrelated, { name: "Synthetic chat" })
    await destination.people.savePeople(unrelated, [{ id: "unrelated-99", name: "Alex Example" }])
    const sameName = await destination.people.personOf({ provider: unrelated.provider, id: "unrelated-99" })
    const preview = await previewDocumentTransfer(f.options)
    expect(preview).toMatchObject({ ready: true, counts: { people: 1, identities: 1, authors: 1 } })
    const receipt = await applyDocumentTransfer({ ...f.options, expected_fingerprint: preview.fingerprint })
    const imported = await destination.people.personOf({ provider: key.provider, id: "editor-42" })
    expect(imported?.uid).not.toBe(sameName?.uid)
    expect(await destination.notes.links({ from: receipt.references[f.doc.ref] })).toEqual(
      expect.arrayContaining([expect.objectContaining({ to: `person:${imported?.uid}`, role: "last-editor" })]),
    )
    const targetDb = await sql(f.destination)
    expect(targetDb.prepare("SELECT token_digest,metadata FROM bots WHERE name='synthetic-reader'").get()).toEqual({
      token_digest: null,
      metadata: null,
    })
    const again = await previewDocumentTransfer(f.options)
    expect(again).toMatchObject({
      already_transferred: true,
      ready: true,
      counts: { people: 0, identities: 0, authors: 0 },
    })
  })

  it("refuses a changed source after a completed transfer and preserves destination edits", async () => {
    const f = await seed()
    const preview = await previewDocumentTransfer(f.options)
    const copied = await applyDocumentTransfer({ ...f.options, expected_fingerprint: preview.fingerprint })
    const destination = await open(f.destination)
    const note = await destination.notes.note(copied.references[f.note.ref] as string)
    await destination.notes.editNote(note.ref, "Later destination edit", note.revision)
    const source = await open(f.source)
    await source.notes.addNote({ text: "Later source edit", about: [f.doc.ref] })
    const changed = await previewDocumentTransfer(f.options)
    expect(changed.ready).toBe(false)
    expect(changed.conflicts).toContain(
      "the source or binding decisions changed after a completed transfer; keep the original store selected",
    )
    await expect(
      applyDocumentTransfer({ ...f.options, expected_fingerprint: changed.fingerprint }),
    ).rejects.toMatchObject({ code: "configuration_error" })
    expect(await destination.notes.note(note.ref)).toMatchObject({ text: "Later destination edit" })
  })

  it("reuses a document by collection and external key while retaining unrelated destination tags", async () => {
    const f = await seed()
    const target = await open(f.destination)
    const other = await target.notes.addFolder({ name: "other-provider:synthetic" })
    await target.notes.saveFileNote({
      folderId: other.id,
      path: "budget.md",
      title: "Unrelated",
      text: "Unrelated body",
    })
    const folder = await target.notes.addFolder({ name: collection })
    const input = {
      folderId: folder.id,
      path: "budget.md",
      title: "Current destination title",
      text: "Budget version one",
      contentHash: "h1",
    }
    const { note: existing } = await target.notes.saveFileNote(input)
    await target.notes.saveFileNote({ ...input, text: "Budget version two", contentHash: "h2" })
    await target.knowledge.addTags(null, { type: "document", id: existing.id }, ["destination-only"])
    const preview = await previewDocumentTransfer(f.options)
    expect(preview.ready).toBe(true)
    const receipt = await applyDocumentTransfer({ ...f.options, expected_fingerprint: preview.fingerprint })
    expect(receipt.references[f.doc.ref]).toBe(existing.ref)
    expect(await target.notes.note(existing.ref)).toMatchObject({
      title: "Current destination title",
      text: "Budget version two",
    })
    expect(await target.knowledge.tags(null, { type: "document", id: existing.id })).toEqual([
      "destination-only",
      "transfer-proof",
    ])
  })

  it("refuses conflicting identity decisions rather than merging two destination people", async () => {
    const f = await seed()
    const source = await open(f.source),
      target = await open(f.destination)
    const first = { provider: "example-one", account: "synthetic-one" },
      second = { provider: "example-two", account: "synthetic-two" }
    for (const store of [source, target]) {
      await store.accounts.saveAccount(first, { name: "First" })
      await store.accounts.saveAccount(second, { name: "Second" })
      await store.people.savePeople(first, [{ id: "42", name: "One person" }])
      await store.people.savePeople(second, [{ id: "73", name: "Another person" }])
    }
    const merged = await source.people.linkIdentities(
      { provider: first.provider, id: "42" },
      { provider: second.provider, id: "73" },
      { method: "manual", by: "owner" },
    )
    await source.notes.addLink({ from: f.doc.ref, to: `person:${merged.uid}`, kind: "links-to", origin: "owner" })
    const preview = await previewDocumentTransfer(f.options)
    expect(preview.ready).toBe(false)
    expect(preview.conflicts).toContain(
      `source identities disagree with the destination person for person:${merged.uid}`,
    )
    await expect(
      applyDocumentTransfer({ ...f.options, expected_fingerprint: preview.fingerprint }),
    ).rejects.toMatchObject({ code: "configuration_error" })
    expect((await target.people.personOf({ provider: first.provider, id: "42" }))?.uid).not.toBe(
      (await target.people.personOf({ provider: second.provider, id: "73" }))?.uid,
    )
  })

  it("refuses duplicate collection identities and an oversized source graph without choosing a first account", async () => {
    const f = await seed()
    const source = await open(f.source)
    await source.notes.addFolder({ name: collection })
    await expect(previewDocumentTransfer(f.options)).rejects.toThrow("duplicate document collection identities")
    const g = await seed()
    const db = await sql(g.source)
    const folder = db.prepare("SELECT account_id FROM documents WHERE id=?").get(Number(g.doc.id))?.account_id as number
    db.exec("BEGIN")
    for (let n = 0; n < 1000; n++)
      db.prepare(
        "INSERT INTO documents(account_id,external_id,kind,body,created_at,updated_at) VALUES(?,?,'file','bounded',0,0)",
      ).run(folder, `synthetic-${n}`)
    db.exec("COMMIT")
    await expect(previewDocumentTransfer(g.options)).rejects.toThrow("1000 document and annotation records")
    expect(existsSync(g.destination)).toBe(false)
  })

  it("refuses a label alias that already identifies another destination tag", async () => {
    const f = await seed()
    const target = await open(f.destination)
    await target.knowledge.createTag("budget-evidence")
    const preview = await previewDocumentTransfer(f.options)
    expect(preview.ready).toBe(false)
    expect(preview.conflicts).toEqual(expect.arrayContaining([expect.stringContaining("destination alias conflicts")]))
    await expect(
      applyDocumentTransfer({ ...f.options, expected_fingerprint: preview.fingerprint }),
    ).rejects.toMatchObject({ code: "configuration_error" })
  })

  it("detects source edits during the copy and retains both the new copy and the changed original", async () => {
    const f = await seed()
    const db = await sql(f.source)
    const preview = await previewDocumentTransfer(f.options)
    const apply = writes.applyTransfer
    vi.spyOn(writes, "applyTransfer").mockImplementation((...args) => {
      const receipt = apply(...args)
      db.prepare("UPDATE notes SET body='Synthetic concurrent edit',revision=revision+1 WHERE id=?").run(
        Number(f.note.id),
      )
      return receipt
    })
    await expect(applyDocumentTransfer({ ...f.options, expected_fingerprint: preview.fingerprint })).rejects.toThrow(
      "source annotations changed during the transfer",
    )
    expect(db.prepare("SELECT body FROM notes WHERE id=?").get(Number(f.note.id))?.body).toBe(
      "Synthetic concurrent edit",
    )
    const target = await open(f.destination)
    expect((await target.notes.notes({ source: "internal" })).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: "Reviewed owner note" })]),
    )
    const retry = await previewDocumentTransfer(f.options)
    expect(retry.ready).toBe(false)
    expect(retry.conflicts).toContain(
      "the source or binding decisions changed after a completed transfer; keep the original store selected",
    )
  })

  it("refuses evidence from an external document whose destination content has changed", async () => {
    const f = await seed()
    const source = await open(f.source),
      target = await open(f.destination)
    const folder = await source.notes.addFolder({ name: "other-documents:synthetic" })
    const { note: evidence } = await source.notes.saveFileNote({
      folderId: folder.id,
      path: "evidence.md",
      title: "Evidence",
      text: "Original external evidence",
      contentHash: "external-h1",
    })
    await source.notes.addLink({ from: f.doc.ref, to: evidence.ref, kind: "evidence", origin: "owner" })
    const destinationFolder = await target.notes.addFolder({ name: "other-documents:synthetic" })
    await target.notes.saveFileNote({
      folderId: destinationFolder.id,
      path: "evidence.md",
      title: "Evidence",
      text: "Changed external evidence",
      contentHash: "external-h2",
    })
    const preview = await previewDocumentTransfer(f.options)
    expect(preview.ready).toBe(false)
    expect(preview.conflicts).toContain(`destination evidence content differs for ${evidence.ref}`)
  })

  it("refuses conflicting destination content and invalid or extraneous bindings", async () => {
    const f = await seed()
    const target = await open(f.destination)
    const folder = await target.notes.addFolder({ name: collection })
    await target.notes.saveFileNote({
      folderId: folder.id,
      path: "budget.md",
      text: "Different destination document",
      title: "Changed",
    })
    expect(await previewDocumentTransfer(f.options)).toMatchObject({
      ready: false,
      conflicts: ["destination content differs for document:1"],
    })
    await expect(
      previewDocumentTransfer({ ...f.options, bindings: { "project:999": "project:1" } }),
    ).rejects.toMatchObject({ code: "validation_error" })
    await expect(
      previewDocumentTransfer({ ...f.options, bindings: { "project:999": 1 } as unknown as Record<string, string> }),
    ).rejects.toMatchObject({ code: "validation_error" })
    await expect(applyDocumentTransfer({ ...f.options, expected_fingerprint: "wrong" })).rejects.toMatchObject({
      code: "validation_error",
    })
  })

  it("rejects the same file through a path, symlink or hardlink and never creates a missing source", async () => {
    const f = await seed()
    const sym = join(f.root, "symbolic.db"),
      hard = join(f.root, "hard.db")
    const aliases = [f.source, hard]
    if (process.platform !== "win32") {
      symlinkSync(f.source, sym)
      aliases.push(sym)
    }
    linkSync(f.source, hard)
    for (const destination of aliases)
      await expect(previewDocumentTransfer({ ...f.options, destination })).rejects.toMatchObject({
        code: "validation_error",
      })
    const missing = join(f.root, "missing.db")
    await expect(previewDocumentTransfer({ ...f.options, source: missing })).rejects.toMatchObject({
      code: "not_found",
    })
    expect(existsSync(missing)).toBe(false)
  })

  describe("a Drive collection, named google-drive:<principal> on either side of store version 31", () => {
    const drive = "google-drive:synthetic-owner"
    const driveAccounts = async (path: string) =>
      (await sql(path))
        .prepare(
          "SELECT a.provider, a.external_id, count(d.id) AS documents FROM accounts a LEFT JOIN documents d ON d.account_id = a.id " +
            "WHERE a.provider = 'google-drive' OR a.name LIKE 'google-drive:%' GROUP BY a.id ORDER BY a.id",
        )
        .all()

    it("copies a stand-in folder from an older source into the google-drive account, never a new folder", async () => {
      const f = await seed(drive)
      const db = await openCache(f.source)
      rollBackTo(db, 31)
      db.close()
      const preview = await previewDocumentTransfer(f.options)
      expect(preview.ready).toBe(true)
      const receipt = await applyDocumentTransfer({ ...f.options, expected_fingerprint: preview.fingerprint })
      expect(receipt.references[f.doc.ref]).toMatch(/^document:/)
      expect(await driveAccounts(f.destination)).toEqual([
        { provider: "google-drive", external_id: "synthetic-owner", documents: 1 },
      ])
      expect((await sql(f.source)).prepare("SELECT provider FROM accounts WHERE name = ?").get(drive)).toEqual({
        provider: "folder",
      })
    })

    it("reuses the destination's moved document for a source that was moved too", async () => {
      const f = await seed(drive)
      const db = await openCache(f.source)
      rollBackTo(db, 31)
      db.close()
      await (await openStore({ path: f.source })).close()
      const target = await open(f.destination)
      const account = await target.notes.documentsAccount(
        { provider: "google-drive", account: "synthetic-owner" },
        true,
      )
      const input = {
        folderId: String(account?.id),
        path: "budget.md",
        title: "Synthetic budget",
        text: "Budget version one",
        contentHash: "h1",
      }
      const { note: existing } = await target.notes.saveFileNote(input)
      await target.notes.saveFileNote({ ...input, text: "Budget version two", contentHash: "h2" })
      const preview = await previewDocumentTransfer(f.options)
      expect(preview.conflicts).toEqual([])
      const receipt = await applyDocumentTransfer({ ...f.options, expected_fingerprint: preview.fingerprint })
      expect(receipt.references[f.doc.ref]).toBe(existing.ref)
      expect(await driveAccounts(f.destination)).toEqual([
        { provider: "google-drive", external_id: "synthetic-owner", documents: 1 },
      ])
    })
  })
})

const minimalTaggedTransfer = async () => {
  const root = mkdtempSync(join(tmpdir(), "consolidated-tag-transfer-"))
  const source = join(root, "source.db"),
    destination = join(root, "destination.db")
  const store = await open(source)
  const folder = await store.notes.addFolder({ name: collection })
  const document = (
    await store.notes.saveFileNote({
      folderId: folder.id,
      path: "session.md",
      title: "Synthetic session",
      text: "Synthetic meeting context",
    })
  ).note
  await store.knowledge.addTags(null, { type: "document", id: document.id }, ["arrival"])
  return { source, destination, store, options: { source, destination, collection } }
}
const consolidateTags = async (store: Awaited<ReturnType<typeof open>>) => {
  const first = await store.knowledge.createTag("welcome")
  const catalog = await store.knowledge.vocabulary()
  const source = catalog.entries.find((row) => row.name === "arrival")
  if (!source) throw Error("missing synthetic arrival tag")
  const options = {
    sourceId: source.id,
    survivorId: String(first.id),
    expectedVocabularyFingerprint: catalog.fingerprint,
  }
  const preview = await store.knowledge.previewTagConsolidation(options)
  await store.knowledge.applyTagConsolidation({
    ...options,
    expectedPreviewFingerprint: preview.previewFingerprint,
    by: "owner",
    idempotencyKey: "transfer-boundary",
  })
}
const image = (path: string) => {
  const digest = createHash("sha256").update(readFileSync(path))
  if (existsSync(`${path}-wal`)) digest.update(readFileSync(`${path}-wal`))
  return digest.digest("hex")
}

it("refuses a consolidated source label before copying or changing either store", async () => {
  const fixture = await minimalTaggedTransfer()
  await consolidateTags(fixture.store)
  const before = image(fixture.source)
  const blocked = await previewDocumentTransfer(fixture.options)
  expect(blocked.ready).toBe(false)
  expect(blocked.conflicts.some((value) => value.includes("consolidated group"))).toBe(true)
  await expect(
    applyDocumentTransfer({ ...fixture.options, expected_fingerprint: blocked.fingerprint }),
  ).rejects.toMatchObject({ code: "configuration_error" })
  expect(image(fixture.source)).toBe(before)
  expect(existsSync(fixture.destination)).toBe(false)
})

it("refuses a consolidated destination label before changing either store", async () => {
  const fixture = await minimalTaggedTransfer()
  const target = await open(fixture.destination)
  await target.knowledge.createTag("arrival")
  await consolidateTags(target)
  const sourceBefore = image(fixture.source),
    targetBefore = image(fixture.destination)
  const blocked = await previewDocumentTransfer(fixture.options)
  expect(blocked.ready).toBe(false)
  expect(blocked.conflicts.some((value) => value.includes("consolidated group"))).toBe(true)
  await expect(
    applyDocumentTransfer({ ...fixture.options, expected_fingerprint: blocked.fingerprint }),
  ).rejects.toMatchObject({ code: "configuration_error" })
  expect(image(fixture.source)).toBe(sourceBefore)
  expect(image(fixture.destination)).toBe(targetBefore)
})
