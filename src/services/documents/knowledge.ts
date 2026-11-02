import { CliError } from "@wirecat/cli-base"
import type { QueryAst } from "@wirecat/cli-base/query"
import type {
  Author,
  Decider,
  Fact,
  Link,
  LinkInput,
  LinkListFilter,
  Memory,
  MemoryInput,
  MessageStore,
  Note,
} from "../../store/index.js"

export interface DocumentKnowledge {
  documents(
    principal: string,
    query: QueryAst | undefined,
    page: { limit: number; offset: number },
  ): Promise<{ items: Note[]; hasMore: boolean }>
  document(principal: string, ref: string): Promise<Note>
  tags(
    principal: string,
    ref: string,
    action: "list" | "add" | "remove",
    tags?: string[],
    filter?: { tag?: string },
  ): Promise<string[]>
  links(principal: string, ref: string, filter?: Omit<LinkListFilter, "from" | "to">): Promise<Link[]>
  addLink(principal: string, ref: string, input: Omit<LinkInput, "from" | "origin">): Promise<Link>
  removeLink(principal: string, ref: string, id: string): Promise<unknown>
  notes(
    principal: string,
    ref: string,
    options?: { search?: string; limit?: number; offset?: number },
  ): Promise<{ items: Note[]; hasMore: boolean }>
  addNote(principal: string, ref: string, text: string, title?: string): Promise<Note>
  note(principal: string, ref: string, noteRef: string): Promise<Note>
  editNote(principal: string, ref: string, noteRef: string, text: string, revision: number): Promise<Note>
  removeNote(principal: string, ref: string, noteRef: string): Promise<unknown>
  addMemory(
    principal: string,
    ref: string,
    input: Pick<MemoryInput, "body" | "kind" | "scope" | "status" | "supersedes"> & { author?: MemoryInput["author"] },
  ): Promise<Memory>
  memories(
    principal: string,
    ref: string,
    options?: { scope?: Memory["scope"]; kind?: Memory["kind"]; status?: Memory["status"]; limit?: number },
  ): Promise<Memory[]>
  memory(principal: string, ref: string, memoryRef: string, action?: "show" | "stale"): Promise<Memory>
  /** `by` decides: the owner, or an agent for the owner that did not propose it. */
  memory(principal: string, ref: string, memoryRef: string, action: "confirm", by: Decider): Promise<Memory>
  searchMemories(
    principal: string,
    ref: string,
    query: string,
    scope?: Memory["scope"],
  ): Promise<{ items: Memory[]; limit_reached: boolean }>
  addFact(
    principal: string,
    ref: string,
    input: {
      statement: string
      type: Fact["type"]
      scope?: Memory["scope"]
      by?: Author
      supersedes?: string
      occurredAt?: string
    },
  ): Promise<Fact>
  facts(
    principal: string,
    ref: string,
    options?: { type?: Fact["type"]; status?: Fact["status"]; limit?: number },
  ): Promise<Fact[]>
  fact(principal: string, ref: string, factRef: string, action?: "show" | "reverse"): Promise<Fact>
  /** `by` decides: the owner, or an agent for the owner that did not propose it. */
  fact(principal: string, ref: string, factRef: string, action: "confirm", by: Decider): Promise<Fact>
}
const decider = (by: Decider | undefined): Decider => {
  if (by === undefined)
    throw new CliError("validation_error", "a confirm names who decides: the owner or an agent with a reason", {
      reason: "proposal.decider-required",
    })
  return by
}

export const documentKnowledge = (
  store: Pick<MessageStore, "notes" | "facts" | "memories" | "knowledge">,
  folder: (principal: string) => Promise<string | undefined>,
): DocumentKnowledge => {
  const document = async (principal: string, ref: string) => {
    const note = await store.notes.resolveNote(ref)
    const folderId = await folder(principal)
    if (!folderId || !note || note.source !== "file" || note.folderId !== folderId || note.deletedAt)
      throw new CliError("not_found", "document is not imported in this source account", {
        reason: "document.not-imported",
      })
    return note
  }
  const noteFor = async (principal: string, ref: string, noteRef: string) => {
    await document(principal, ref)
    const note = await store.notes.resolveNote(noteRef)
    const linked = (await store.notes.links({ from: noteRef })).some((link) => link.to === ref && link.kind === "about")
    // A note's primary subject is included by the shared about query, not necessarily a links row.
    if (note?.source !== "internal" || note.deletedAt)
      throw new CliError("not_found", "note is not attached to this document")
    if (linked) return note
    for (let offset = 0; offset <= 10000; offset += 500) {
      const page = await store.notes.notes({ source: "internal", about: ref, limit: 500, offset })
      if (page.items.some((n) => n.ref === noteRef)) return note
      if (!page.hasMore) throw new CliError("not_found", "note is not attached to this document")
    }
    throw new CliError("provider_error", "document note lookup exceeded its bound")
  }
  const memoryFor = async (principal: string, ref: string, memoryRef: string) => {
    await document(principal, ref)
    const memory = await store.memories.get(memoryRef)
    if (memory.subject !== ref || !memory.evidence.includes(ref))
      throw new CliError("not_found", "memory is not attached to this document")
    return memory
  }
  const factFor = async (principal: string, ref: string, factRef: string) => {
    await document(principal, ref)
    const fact = await store.facts.get(factRef)
    if (fact.subject !== ref || !fact.evidence.includes(ref))
      throw new CliError("not_found", "fact is not attached to this document")
    return fact
  }
  const port: DocumentKnowledge = {
    documents: async (principal, query, page) => {
      const folderId = await folder(principal)
      return folderId ? store.notes.importedDocuments(folderId, query, page) : { items: [], hasMore: false }
    },
    document,
    tags: async (principal, ref, action, tags = [], filter) => {
      const note = await document(principal, ref)
      const target = { type: "document" as const, id: note.id }
      if (action === "add") return store.knowledge.addTags(null, target, tags)
      if (action === "remove") return store.knowledge.removeTags(null, target, tags)
      return store.knowledge.tags(null, target, filter?.tag)
    },
    links: async (principal, ref, filter) => {
      await document(principal, ref)
      return store.notes.links({ ...filter, from: ref })
    },
    addLink: async (principal, ref, input) => {
      await document(principal, ref)
      return store.notes.addLink({ ...input, from: ref, origin: "owner" })
    },
    removeLink: async (principal, ref, id) => {
      const links = await port.links(principal, ref)
      if (!links.some((link) => link.id === id && link.origin === "owner"))
        throw new CliError("not_found", "owner link is not attached to this document")
      return store.notes.removeLink(id)
    },
    notes: async (principal, ref, options) => {
      await document(principal, ref)
      return store.notes.notes({ ...options, source: "internal", about: ref })
    },
    addNote: async (principal, ref, text, title) => {
      await document(principal, ref)
      return store.notes.addNote({ text, ...(title ? { title } : {}), about: [ref] })
    },
    note: noteFor,
    editNote: async (principal, ref, noteRef, text, revision) => {
      const note = await noteFor(principal, ref, noteRef)
      return store.notes.editNote(note.id, text, revision)
    },
    removeNote: async (principal, ref, noteRef) => {
      const note = await noteFor(principal, ref, noteRef)
      return store.notes.removeNote(note.id)
    },
    addMemory: async (principal, ref, input) => {
      await document(principal, ref)
      if (input.supersedes) await memoryFor(principal, ref, input.supersedes)
      return store.memories.add({ ...input, subject: ref, evidence: [ref], author: input.author ?? "owner" })
    },
    memories: async (principal, ref, options) => {
      await document(principal, ref)
      return store.memories.list({ ...options, subject: ref })
    },
    memory: async (principal: string, ref: string, memoryRef: string, action = "show", by?: Decider) => {
      const memory = await memoryFor(principal, ref, memoryRef)
      if (action === "confirm") return store.memories.confirm(memory.ref, decider(by))
      if (action === "stale") return store.memories.markStale(memory.ref)
      return memory
    },
    searchMemories: async (principal, ref, query, scope) => {
      await document(principal, ref)
      const items = await store.memories.search(query, { subject: ref, ...(scope ? { scope } : {}), limit: 200 })
      return { items, limit_reached: items.length === 200 }
    },
    addFact: async (principal, ref, { statement, type, scope, by, supersedes, occurredAt }) => {
      await document(principal, ref)
      if (supersedes) await factFor(principal, ref, supersedes)
      return store.facts.add({
        type,
        statement,
        by: by ?? "owner",
        ...(supersedes === undefined ? {} : { supersedes }),
        ...(occurredAt === undefined ? {} : { occurredAt }),
        subject: ref,
        evidence: [ref],
        ...(scope === undefined ? {} : { scope }),
      })
    },
    facts: async (principal, ref, options) => {
      await document(principal, ref)
      return store.facts.list({ ...options, subject: ref })
    },
    fact: async (principal: string, ref: string, factRef: string, action = "show", by?: Decider) => {
      const fact = await factFor(principal, ref, factRef)
      if (action === "confirm") return store.facts.accept(fact.ref, decider(by))
      if (action === "reverse") return store.facts.reverse(fact.ref)
      return fact
    },
  }
  return port
}
