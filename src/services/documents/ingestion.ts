import { CliError } from "@wirecat/cli-base"
import { walkQuery } from "@wirecat/cli-base/query"
import type { SourceContent, SourceFile } from "../../documents/model.js"
import type { CatalogInput, CatalogQuery, MessageStore, Note } from "../../store/index.js"
export interface IngestionOptions<M extends SourceFile> {
  collectionName(principal: string): string
  externalId(id: string): string
  catalogInput(file: M): CatalogInput
  frontMatter(content: SourceContent<M>): Record<string, unknown>
  observed?(principal: string, file: M, documentId: string): Promise<void>
}
export const documentIngestion = <M extends SourceFile>(
  store: Pick<MessageStore, "notes" | "catalog" | "memories">,
  options: IngestionOptions<M>,
) => {
  const folder = async (principal: string, create: boolean) => {
    const name = options.collectionName(principal)
    const found = (await store.notes.folders()).find((item) => item.name === name)
    return found ?? (create ? await store.notes.addFolder({ name, format: "markdown" }) : undefined)
  }
  const documents = new Map<string, Map<string, Note>>()
  const cached = async (principal: string) => {
    const known = documents.get(principal)
    if (known) return known
    const notes = new Map<string, Note>()
    const selected = await folder(principal, false)
    if (selected) {
      for (let offset = 0; ; offset += 500) {
        const page = await store.notes.notes({ folderId: selected.id, source: "file", limit: 500, offset })
        for (const note of page.items) if (note.path) notes.set(note.path, note)
        if (!page.hasMore) break
        if (offset >= 10000) throw new CliError("provider_error", "local document listing exceeded its bound")
      }
    }
    documents.set(principal, notes)
    return notes
  }
  const stale = async (ref: string) => {
    for (const status of ["proposed", "confirmed"] as const) {
      for (let batch = 0; ; batch++) {
        const memories = await store.memories.list({ subject: ref, status, limit: 500 })
        for (const memory of memories) await store.memories.markStale(memory.ref)
        if (memories.length < 500) break
        if (batch >= 20) throw new CliError("provider_error", "memory invalidation exceeded its batch bound")
      }
    }
  }
  return {
    catalog: {
      import: async (principal: string, files: M[]) => {
        if (files.length > 10000)
          throw new CliError("validation_error", "catalog scope exceeds 10000 entries", {
            reason: "catalog.scope-limit",
          })
        const selected = await folder(principal, true)
        if (!selected) throw new CliError("configuration_error", "catalog collection could not be registered")
        for (let start = 0; start < files.length; start += 200) {
          await store.catalog.upsert(selected.id, files.slice(start, start + 200).map(options.catalogInput))
        }
        for (const file of files) {
          const entry = await store.catalog.get(selected.id, options.externalId(file.id))
          if (entry) await options.observed?.(principal, file, entry.ref.slice("document:".length))
        }
        const retired = await store.catalog.reconcile(
          selected.id,
          files.map((file) => options.externalId(file.id)),
        )
        documents.delete(principal)
        return { entries: files.length, retired }
      },
      get: async (principal: string, id: string) => {
        const selected = await folder(principal, false)
        return selected ? store.catalog.get(selected.id, options.externalId(id)) : undefined
      },
      list: async (principal: string, query: CatalogQuery = {}) => {
        const selected = await folder(principal, false)
        const ast = query.ast ? structuredClone(query.ast) : undefined
        if (ast)
          for (const node of walkQuery(ast.root))
            if (node.field === "parent") node.value = options.externalId(node.value)
        return selected
          ? store.catalog.list(selected.id, {
              ...query,
              ...(ast ? { ast } : {}),
              ...(query.parent === undefined ? {} : { parent: options.externalId(query.parent) }),
            })
          : { items: [], hasMore: false }
      },
    },
    collection: folder,
    save: async (principal: string, content: SourceContent<M>, hash: string) => {
      const selected = await folder(principal, true)
      if (!selected) throw new Error("folder registration failed")
      const notes = await cached(principal)
      const path = options.externalId(content.metadata.id)
      const before = notes.get(path)
      if (before && before.contentHash !== hash) await stale(before.ref)
      const { note } = await store.notes.saveFileNote({
        folderId: selected.id,
        path: options.externalId(content.metadata.id),
        title: content.metadata.name,
        text: content.text,
        contentHash: hash,
        frontMatter: options.frontMatter(content),
      })
      await store.catalog.upsert(selected.id, [options.catalogInput(content.metadata)])
      await options.observed?.(principal, content.metadata, note.id)
      notes.set(path, note)
      return note.ref
    },
    remove: async (principal: string, id: string) => {
      const selected = await folder(principal, false)
      if (selected) {
        const notes = await cached(principal)
        const path = options.externalId(id)
        const note = notes.get(path)
        const retired = note ? undefined : await store.catalog.get(selected.id, path, true)
        const ref = note?.ref ?? retired?.ref
        if (ref) await stale(ref)
        await store.notes.deleteFileNotes(selected.id, [path])
        notes.delete(path)
      }
    },
  }
}
