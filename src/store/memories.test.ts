import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openCache } from "./open.js"
import type { MemoryInput } from "./sqlite/memories.js"
import { type MessageStore, openStore } from "./store.js"

const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})
const open = async (path = join(mkdtempSync(join(tmpdir(), "memories-")), "store.db")) => {
  const store = await openStore({ path })
  live.push(store)
  return store
}
const sql = async (path: string, statement: string) => {
  const database = await openCache(path)
  try {
    return database.prepare(statement).all()
  } finally {
    database.close()
  }
}
const fileHolds = (path: string, word: string) =>
  [path, `${path}-wal`].some((file) => {
    try {
      return readFileSync(file).includes(word)
    } catch {
      return false
    }
  })
const agent = { bot: "digest-writer", model: "synthetic-model-1" }

describe("memories", () => {
  it("refuse a memory without its scope or without evidence, writing nothing", async () => {
    const store = await open()
    const note = await store.notes.addNote({ text: "Alice Example prefers mornings" })
    const input: MemoryInput = {
      kind: "preference",
      body: "Alice prefers morning calls",
      scope: "work",
      evidence: [note.ref],
      author: agent,
    }
    await expect(store.memories.add({ ...input, scope: undefined as unknown as "work" })).rejects.toMatchObject({
      code: "validation_error",
      details: { reason: "memory.scope-required" },
    })
    await expect(store.memories.add({ ...input, evidence: [] })).rejects.toMatchObject({
      code: "validation_error",
      details: { reason: "memory.evidence-required" },
    })
    await expect(store.memories.add({ ...input, evidence: ["note:999"] })).rejects.toMatchObject({ code: "not_found" })
    expect(await store.memories.list()).toEqual([])
  })

  it("keep their evidence, author and model, are found by their words, and give way to a newer one", async () => {
    const store = await open()
    const note = await store.notes.addNote({ text: "Bob Sample moved the review to Fridays" })
    const first = await store.memories.add({
      kind: "summary",
      body: "The review is on Fridays",
      scope: "work",
      evidence: [note.ref],
      author: agent,
      confidence: 0.8,
    })
    expect(first).toMatchObject({ status: "proposed", scope: "work", model: "synthetic-model-1", evidence: [note.ref] })
    expect(first.author).toMatchObject({ type: "bot", name: "digest-writer" })
    expect((await store.memories.search("friday")).map(({ author }) => author.name)).toEqual(["digest-writer"])
    expect(await store.memories.search("friday", { scope: "personal" })).toEqual([])

    const newer = await store.memories.add({
      kind: "summary",
      body: "The review is on Mondays",
      scope: "work",
      evidence: [note.ref],
      author: "owner",
      status: "confirmed",
      supersedes: first.ref,
    })
    expect(await store.memories.get(first.ref)).toMatchObject({ status: "superseded" })
    expect(newer).toMatchObject({ status: "confirmed", supersedes: first.ref, lastVerifiedAt: expect.any(String) })
    expect(newer.author).toMatchObject({ type: "person", name: null })
    expect((await store.memories.list()).map(({ author }) => author.name)).toEqual([null, "digest-writer"])
    expect((await store.memories.search("review")).map(({ id }) => id)).toEqual([newer.id])
    expect(await store.memories.indexState()).toMatchObject({ pending: 0 })
  })

  it("search one subject before the limit, so its memory is found below the others' best", async () => {
    const store = await open()
    const busy = await store.notes.addNote({ text: "Planning notes" })
    const quiet = await store.notes.addNote({ text: "Retro notes" })
    const remember = (subject: string) =>
      store.memories.add({
        kind: "summary",
        body: "The review is on Fridays",
        scope: "work",
        subject,
        evidence: [subject],
        author: agent,
      })
    for (let index = 0; index < 3; index += 1) await remember(busy.ref)
    const mine = await remember(quiet.ref)

    expect((await store.memories.search("review", { limit: 3 })).map(({ subject }) => subject)).toEqual([
      busy.ref,
      busy.ref,
      busy.ref,
    ])
    expect((await store.memories.search("review", { subject: quiet.ref, limit: 1 })).map(({ id }) => id)).toEqual([
      mine.id,
    ])
    await expect(store.memories.search("review", { subject: "note:999" })).rejects.toMatchObject({ code: "not_found" })
  })
})

describe("a memory's project", () => {
  it("is named on the memory and on a fact, filters the list, and moves or clears", async () => {
    const store = await open()
    const harbour = await store.knowledge.addProject({ name: "Project Harbour", type: "work" })
    const lighthouse = await store.knowledge.addProject({ name: "Lighthouse", type: "work" })
    const note = await store.notes.addNote({ text: "Synthetic evidence" })
    const add = (project?: string) =>
      store.memories.add({
        kind: "summary",
        body: "x",
        scope: "work",
        evidence: [note.ref],
        author: agent,
        ...(project === undefined ? {} : { project }),
      })

    const inHarbour = await add(harbour.ref)
    const loose = await add()
    expect(inHarbour).toMatchObject({ project: harbour.ref, projectName: "Project Harbour" })
    expect(loose).toMatchObject({ project: null, projectName: null })
    expect((await store.memories.list({ project: harbour.ref })).map((one) => one.ref)).toEqual([inHarbour.ref])
    await expect(add(note.ref)).rejects.toThrow("is not a project")

    expect(await store.memories.update(loose.ref, { project: lighthouse.ref })).toMatchObject({
      project: lighthouse.ref,
      projectName: "Lighthouse",
    })
    expect(await store.memories.update(inHarbour.ref, { project: null })).toMatchObject({ project: null })
    expect(await store.facts.add({ type: "fact", statement: "y", by: "owner", project: harbour.ref })).toMatchObject({
      project: harbour.ref,
      projectName: "Project Harbour",
    })
  })
})

describe("forgetting a memory", () => {
  it("erases its row, words, pieces, vector and links, and the text from the file; the rest stays", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memories-")), "store.db")
    const store = await open(path)
    const note = await store.notes.addNote({ text: "Kai Sample asked for calls on Fridays" })
    const wrong = await store.memories.add({
      kind: "preference",
      body: "Kai Sample prefers zanzibarcalls",
      scope: "work",
      evidence: [note.ref],
      author: agent,
    })
    expect((await store.memories.search("zanzibarcalls")).map(({ ref }) => ref)).toEqual([wrong.ref])
    const [piece] = (await sql(
      path,
      `SELECT content_hash FROM chunks WHERE chunkable_type = 'memory' AND chunkable_id = ${wrong.id}`,
    )) as { content_hash: string }[]
    const database = await openCache(path)
    database.exec(
      `INSERT INTO embeddings (model, content_hash, dims, vector, created_at, updated_at) VALUES ('m', '${piece?.content_hash}', 1, x'00000000', 1, 1)`,
    )
    database.close()
    expect(fileHolds(path, "zanzibarcalls")).toBe(true)
    const right = await store.memories.add({
      kind: "preference",
      body: "Kai Sample prefers Friday calls",
      scope: "work",
      evidence: [note.ref],
      author: "owner",
      status: "confirmed",
      supersedes: wrong.ref,
    })
    const kept = await store.memories.add({
      kind: "summary",
      body: "Kai Sample runs the harbour project",
      scope: "work",
      evidence: [note.ref, wrong.ref],
      author: agent,
    })
    await store.memories.search("harbour")

    expect(await store.memories.remove(wrong.ref)).toEqual({ ref: wrong.ref, removed: true, links: 2 })

    await expect(store.memories.get(wrong.ref)).rejects.toMatchObject({ code: "not_found" })
    expect(await store.memories.get(right.ref)).toMatchObject({ supersedes: null, status: "confirmed" })
    expect(await store.memories.get(kept.ref)).toMatchObject({ evidence: [note.ref] })
    expect((await store.memories.search("friday")).map(({ ref }) => ref)).toEqual([right.ref])
    expect(await store.notes.note(note.ref)).toMatchObject({ ref: note.ref })
    const id = Number(wrong.id)
    expect(
      await sql(
        path,
        `SELECT (SELECT count(*) FROM memories WHERE id = ${id}) AS rows,
          (SELECT count(*) FROM links WHERE (from_type = 'memory' AND from_id = ${id}) OR (to_type = 'memory' AND to_id = ${id})) AS links,
          (SELECT count(*) FROM chunks WHERE chunkable_type = 'memory' AND chunkable_id = ${id}) AS pieces,
          (SELECT count(*) FROM memory_words_vocab WHERE term LIKE 'zanzibar%') AS words,
          (SELECT count(*) FROM embeddings WHERE content_hash = '${piece?.content_hash}') AS vectors,
          (SELECT count(*) FROM memories) AS memories, (SELECT count(*) FROM notes) AS notes`,
      ),
    ).toEqual([{ rows: 0, links: 0, pieces: 0, words: 0, vectors: 0, memories: 2, notes: 1 }])
    expect(fileHolds(path, "zanzibarcalls")).toBe(false)
    await expect(store.memories.remove(wrong.ref)).rejects.toMatchObject({ code: "not_found" })

    expect(await store.memories.remove(kept.ref)).toMatchObject({ removed: true, links: 1 })
    expect(await store.memories.search("harbour")).toEqual([])
    expect(await sql(path, "SELECT count(*) AS n FROM memory_words_vocab WHERE term LIKE 'harbour%'")).toEqual([
      { n: 0 },
    ])
    expect(fileHolds(path, "harbour")).toBe(false)
  })

  it("read back each source with an excerpt, and say which one was deleted since", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memories-")), "store.db")
    const store = await open(path)
    const stays = await store.notes.addNote({ title: "Call notes", text: "Kai Sample: Fridays work best for me" })
    const goes = await store.notes.addNote({ text: "Kai Sample: maybe Thursdays" })
    const memory = await store.memories.add({
      kind: "preference",
      body: "Kai Sample prefers Friday calls",
      scope: "work",
      evidence: [stays.ref, goes.ref],
      author: agent,
    })
    await sql(path, `UPDATE notes SET deleted_at = 1 WHERE id = ${goes.ref.replace("note:", "")}`)

    expect(await store.memories.sources(memory.ref)).toEqual([
      {
        ref: stays.ref,
        kind: "note",
        title: "Call notes",
        sender: null,
        at: expect.any(String),
        excerpt: "Kai Sample: Fridays work best for me",
        tool: "notes",
        missing: false,
      },
      expect.objectContaining({ ref: goes.ref, kind: "note", excerpt: null, missing: true }),
    ])
  })

  it("name the subject: a person by name or identity, a project by name, the owner as the owner", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memories-")), "store.db")
    const store = await open(path)
    const project = await store.knowledge.addProject({ name: "Project Harbour", type: "work" })
    await sql(path, "INSERT INTO persons (id, name, owner, created_at, updated_at) VALUES (21, 'Kai Sample', 0, 0, 0)")
    await sql(path, "INSERT INTO persons (id, name, owner, created_at, updated_at) VALUES (22, NULL, 0, 0, 0)")
    await sql(
      path,
      "INSERT INTO identities (id, provider, external_id, name, created_at, updated_at) VALUES (5, 'telegram', '77', 'Ana Ruiz', 0, 0)",
    )
    await sql(
      path,
      "INSERT INTO identity_links (identity_id, person_id, method, confidence, created_at, author, updated_at) " +
        "VALUES (5, 22, 'manual', 1, 0, 'owner', 0)",
    )
    const [owner] = (await sql(path, "SELECT id FROM persons WHERE owner = 1")) as { id: number }[]
    const note = await store.notes.addNote({ text: "Synthetic evidence" })
    const about = (subject: string) =>
      store.memories.add({ kind: "summary", body: "x", scope: "work", evidence: [note.ref], author: agent, subject })

    expect(await about("person:21")).toMatchObject({ subjectName: "Kai Sample", subjectIsOwner: false })
    expect(await about("person:22")).toMatchObject({ subjectName: "Ana Ruiz", subjectIsOwner: false })
    expect(await about(`person:${owner?.id}`)).toMatchObject({ subjectName: null, subjectIsOwner: true })
    expect(await about(project.ref)).toMatchObject({ subjectName: "Project Harbour" })
    expect(await store.facts.add({ type: "fact", statement: "y", by: "owner", subject: "person:21" })).toMatchObject({
      subjectName: "Kai Sample",
    })
  })
})

describe("facts", () => {
  it("wait as proposed from an agent, hold once accepted, and a decision stops holding when replaced", async () => {
    const store = await open()
    const project = await store.knowledge.addProject({ name: "Lighthouse", type: "work" })
    const note = await store.notes.addNote({ text: "We agreed on Postgres" })
    const memory = await store.memories.add({
      kind: "summary",
      body: "Postgres was chosen",
      scope: "work",
      evidence: [note.ref],
      author: agent,
    })
    const proposed = await store.facts.add({
      type: "decision",
      statement: "Use Postgres",
      by: agent,
      project: project.ref,
      evidence: [note.ref],
      createdFrom: memory.ref,
    })
    expect(proposed).toMatchObject({
      type: "decision",
      status: "proposed",
      confirmedBy: null,
      author: { type: "bot", name: "digest-writer" },
      model: "synthetic-model-1",
      evidence: [note.ref],
      project: project.ref,
    })
    expect(await store.facts.accept(proposed.ref, "owner")).toMatchObject({
      status: "accepted",
      confirmedBy: { type: "person" },
    })

    const replacement = await store.facts.add({
      type: "decision",
      statement: "Use SQLite",
      by: "owner",
      supersedes: proposed.ref,
    })
    expect(replacement).toMatchObject({ status: "accepted", author: { type: "person", name: null } })
    expect(await store.facts.get(proposed.ref)).toMatchObject({ status: "superseded" })
    expect((await store.facts.list({ project: project.ref })).map(({ ref, author }) => [ref, author.name])).toEqual([
      [proposed.ref, "digest-writer"],
    ])
    expect(await store.facts.reverse(replacement.ref)).toMatchObject({ status: "reversed" })
  })

  it("reverse only decisions, and list by type and subject", async () => {
    const store = await open()
    const note = await store.notes.addNote({ text: "Bob Sample asked when the review is" })
    const person = await store.knowledge.addProject({ name: "Review", type: "work" })
    const question = await store.facts.add({
      type: "question",
      statement: "When is the review?",
      by: "owner",
      subject: note.ref,
      evidence: [note.ref],
      scope: "work",
    })
    const statement = await store.facts.add({ type: "statement", statement: "The review moved", by: agent })
    expect(question).toMatchObject({ status: "accepted", subject: note.ref, scope: "work" })
    expect(statement.status).toBe("proposed")
    await expect(store.facts.reverse(question.ref)).rejects.toMatchObject({ code: "validation_error" })
    await expect(store.facts.add({ type: "rumour" as "fact", statement: "x", by: "owner" })).rejects.toMatchObject({
      code: "validation_error",
    })
    expect((await store.facts.list({ type: "question" })).map(({ ref }) => ref)).toEqual([question.ref])
    expect((await store.facts.list({ subject: note.ref })).map(({ ref }) => ref)).toEqual([question.ref])
    expect((await store.facts.list({ status: "proposed" })).map(({ ref }) => ref)).toEqual([statement.ref])
    expect(await store.facts.list({ project: person.ref })).toEqual([])
  })

  it("correct a fact of any kind, proposed or accepted, and the old one is superseded once the new one holds", async () => {
    const store = await open()
    const statement = await store.facts.add({ type: "statement", statement: "The review moved", by: agent })
    const question = await store.facts.add({ type: "question", statement: "When is it?", by: "owner" })

    const fixed = await store.facts.add({
      type: "statement",
      statement: "The review moved to May",
      by: "owner",
      supersedes: statement.ref,
    })
    expect(fixed).toMatchObject({ status: "accepted", supersedes: statement.ref })
    expect(await store.facts.get(statement.ref)).toMatchObject({ status: "superseded" })

    const proposal = await store.facts.add({
      type: "question",
      statement: "When in May?",
      by: agent,
      supersedes: question.ref,
    })
    expect(await store.facts.get(question.ref)).toMatchObject({ status: "accepted" })
    await store.facts.accept(proposal.ref, "owner")
    expect(await store.facts.get(question.ref)).toMatchObject({ status: "superseded" })

    for (const done of [statement, question])
      await expect(
        store.facts.add({ type: "fact", statement: "x", by: "owner", supersedes: done.ref }),
      ).rejects.toMatchObject({ code: "validation_error" })
  })

  it("reject only a proposed fact, and forget one with its links and the memory it was migrated from", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memories-")), "store.db")
    const store = await open(path)
    const note = await store.notes.addNote({ text: "Ana Ruiz promised the draft" })
    const proposed = await store.facts.add({
      type: "promise",
      statement: "Ana sends the draft",
      by: agent,
      evidence: [note.ref],
    })
    const owned = await store.facts.add({ type: "fact", statement: "The draft is due", by: "owner" })
    await expect(store.facts.reject(owned.ref, "owner")).rejects.toMatchObject({ code: "validation_error" })
    expect(await store.facts.reject(proposed.ref, "owner")).toMatchObject({ status: "rejected" })
    expect((await store.facts.list({ status: "rejected" })).map(({ ref }) => ref)).toEqual([proposed.ref])

    const first = await store.facts.add({
      type: "decision",
      statement: "Ship in quokkamarch",
      by: "owner",
      evidence: [note.ref],
    })
    const second = await store.facts.add({
      type: "decision",
      statement: "Ship in April",
      by: "owner",
      supersedes: first.ref,
    })
    await sql(
      path,
      "INSERT INTO memories (id, kind, body, author_type, author_id, status, scope, created_at, updated_at, deleted_at) " +
        "VALUES (90, 'summary', 'Ship in quokkamarch', 'person', 1, 'confirmed', 'work', 0, 0, 1)",
    )
    await sql(path, `UPDATE facts SET source = 'memory', metadata = '{"memory":90}' WHERE id = ${first.id}`)

    expect(await store.facts.remove(first.ref)).toEqual({ ref: first.ref, removed: true, links: 1 })
    await expect(store.facts.get(first.ref)).rejects.toMatchObject({ code: "not_found" })
    expect(await store.facts.get(second.ref)).toMatchObject({ supersedes: null, status: "accepted" })
    expect(
      await sql(
        path,
        `SELECT (SELECT count(*) FROM memories WHERE id = 90) AS twin,
          (SELECT count(*) FROM links WHERE from_type = 'fact' AND from_id = ${first.id}) AS links,
          (SELECT count(*) FROM facts) AS facts, (SELECT count(*) FROM notes) AS notes`,
      ),
    ).toEqual([{ twin: 0, links: 0, facts: 3, notes: 1 }])
    expect(fileHolds(path, "quokkamarch")).toBe(false)
  })

  it("never hand a forgotten memory's or fact's number to the next one, across a reopen", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "memories-")), "store.db")
    const store = await open(path)
    const note = await store.notes.addNote({ text: "Synthetic evidence" })
    const memory = () =>
      store.memories.add({ kind: "summary", body: "x", scope: "work", evidence: [note.ref], author: agent })
    const fact = () => store.facts.add({ type: "fact", statement: "y", by: agent, evidence: [note.ref] })
    await memory()
    const highestMemory = await memory()
    await fact()
    const highestFact = await fact()
    await store.memories.remove(highestMemory.ref)
    await store.facts.remove(highestFact.ref)
    await store.close()
    live.splice(live.indexOf(store), 1)

    const reopened = await open(path)
    const nextMemory = await reopened.memories.add({
      kind: "summary",
      body: "z",
      scope: "work",
      evidence: [note.ref],
      author: agent,
    })
    const nextFact = await reopened.facts.add({ type: "fact", statement: "w", by: agent, evidence: [note.ref] })
    expect(Number(nextMemory.id)).toBe(Number(highestMemory.id) + 1)
    expect(Number(nextFact.id)).toBe(Number(highestFact.id) + 1)
    await expect(reopened.memories.get(highestMemory.ref)).rejects.toMatchObject({ code: "not_found" })
    await expect(reopened.facts.get(highestFact.ref)).rejects.toMatchObject({ code: "not_found" })
  })
})
