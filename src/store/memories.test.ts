import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { MemoryInput } from "./sqlite/memories.js"
import { type MessageStore, openStore } from "./store.js"

const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})
const open = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "memories-")), "store.db") })
  live.push(store)
  return store
}
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
    expect(await store.facts.accept(proposed.ref)).toMatchObject({
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

  it("supersede and reverse only decisions, and list by type and subject", async () => {
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
    await expect(
      store.facts.add({ type: "statement", statement: "x", by: "owner", supersedes: question.ref }),
    ).rejects.toMatchObject({ code: "validation_error" })
    await expect(
      store.facts.add({ type: "decision", statement: "x", by: "owner", supersedes: question.ref }),
    ).rejects.toMatchObject({ code: "validation_error" })
    await expect(store.facts.add({ type: "rumour" as "fact", statement: "x", by: "owner" })).rejects.toMatchObject({
      code: "validation_error",
    })
    expect((await store.facts.list({ type: "question" })).map(({ ref }) => ref)).toEqual([question.ref])
    expect((await store.facts.list({ subject: note.ref })).map(({ ref }) => ref)).toEqual([question.ref])
    expect((await store.facts.list({ status: "proposed" })).map(({ ref }) => ref)).toEqual([statement.ref])
    expect(await store.facts.list({ project: person.ref })).toEqual([])
  })
})
