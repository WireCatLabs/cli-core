import { CliError, isCliError } from "@wirecat/cli-base"
import { walkQuery } from "@wirecat/cli-base/query"
import type { SourceContent, SourceFile, SourceRemoval } from "../../documents/model.js"
import type { CatalogInput, CatalogQuery, MessageStore } from "../../store/index.js"
export interface IngestionOptions<M extends SourceFile> {
  /**
   * The documents account's provider (`google-drive`): each principal's documents live under
   * `{ provider, account: principal }`. Without it they live in a notes folder named `collectionName(principal)`.
   */
  provider?: string
  /** The CLI's command (`notion`), which names its profiles: with `provider`, a sync records which account each is. */
  command?: string
  collectionName?(principal: string): string
  externalId(id: string): string
  catalogInput(file: M): CatalogInput
  frontMatter(content: SourceContent<M>): Record<string, unknown>
  observed?(principal: string, file: M, documentId: string): Promise<void>
}
export const documentIngestion = <M extends SourceFile>(
  store: Pick<MessageStore, "notes" | "catalog" | "memories" | "accounts">,
  options: IngestionOptions<M>,
) => {
  const folder = async (principal: string, create: boolean) => {
    if (options.provider)
      return store.notes.documentsAccount({ provider: options.provider, account: principal }, create)
    if (!options.collectionName)
      throw new CliError("configuration_error", "document ingestion needs a provider or a collection name")
    const name = options.collectionName(principal)
    const found = (await store.notes.folders()).find((item) => item.name === name)
    return found ?? (create ? await store.notes.addFolder({ name, format: "markdown" }) : undefined)
  }
  // The catalog answers external ids (`<id>.md`), so an id given back as it was answered is found too.
  const both = (id: string) => [...new Set([options.externalId(id), id])]
  const stale = async (ref: string) => {
    for (const status of ["proposed", "confirmed"] as const) {
      for (let batch = 0; ; batch++) {
        const { items, hasMore } = await store.memories.list({ subject: ref, status, limit: 500 })
        for (const memory of items) await store.memories.markStale(memory.ref, "owner")
        if (!hasMore) break
        if (batch >= 20) throw new CliError("provider_error", "memory invalidation exceeded its batch bound")
      }
    }
  }
  const { provider, command } = options
  return {
    // Only where both are known: a sync calls it whenever it is there and a profile is given.
    ...(provider && command
      ? {
          /** Names the profile's account in the store, so a search hit says `notion`/`work`, not `notes`/`1`. */
          registerProfile: async (name: string, principal: string) => {
            await folder(principal, true)
            await store.accounts.saveProfile(command, name, { provider, account: principal })
          },
        }
      : {}),
    catalog: {
      import: async (principal: string, files: M[]) => {
        const selected = await folder(principal, true)
        if (!selected) throw new CliError("configuration_error", "catalog collection could not be registered")
        for (let start = 0; start < files.length; start += 200) {
          const chunk = files.slice(start, start + 200)
          await store.catalog.upsert(selected.id, chunk.map(options.catalogInput))
          if (options.observed)
            for (const file of chunk) {
              const entry = await store.catalog.get(selected.id, options.externalId(file.id))
              if (entry) await options.observed(principal, file, entry.ref.slice("document:".length))
            }
        }
        const retired = await store.catalog.reconcile(
          selected.id,
          files.map((file) => options.externalId(file.id)),
        )
        return { entries: files.length, retired }
      },
      get: async (principal: string, id: string) => {
        const selected = await folder(principal, false)
        if (!selected) return undefined
        const entry = await store.catalog.get(selected.id, options.externalId(id))
        return entry ?? (options.externalId(id) === id ? undefined : store.catalog.get(selected.id, id))
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
              ...(query.parent === undefined ? {} : { parent: [query.parent].flat().flatMap(both) }),
            })
          : { items: [], hasMore: false }
      },
    },
    collection: folder,
    // A store fake that predates `indexWritten` leaves the text for the next search to index.
    settle: async ({ until }: { until: () => boolean }) => store.notes.indexWritten?.({ until }),
    save: async (principal: string, content: SourceContent<M>, hash: string) => {
      const selected = await folder(principal, true)
      if (!selected) throw new Error("folder registration failed")
      const path = options.externalId(content.metadata.id)
      const before = await store.notes.fileNote(selected.id, path)
      if (before && before.contentHash !== hash) await stale(before.ref)
      const { note } = await store.notes.saveFileNote({
        folderId: selected.id,
        path,
        title: content.metadata.name,
        text: content.text,
        contentHash: hash,
        frontMatter: options.frontMatter(content),
      })
      await store.catalog.upsert(selected.id, [options.catalogInput(content.metadata)])
      await options.observed?.(principal, content.metadata, note.id)
      return note.ref
    },
    /**
     * Moves a synced document to the new id its source gave the file, as a replace through a temporary file does, so
     * its tags, the notes about it and its links stay with it. False when the file was never synced.
     */
    rekey: async (principal: string, from: string, to: string) => {
      const selected = await folder(principal, false)
      if (!selected) return false
      try {
        const [was, now] = [options.externalId(from), options.externalId(to)]
        const note = await store.notes.renameFileNote(selected.id, was, now, { fold: true })
        await stale(note.ref)
        return true
      } catch (error) {
        if (isCliError(error) && error.code === "not_found") return false
        throw error
      }
    },
    remove: async (principal: string, id: string, reason?: SourceRemoval) => {
      const selected = await folder(principal, false)
      if (selected) {
        const path = options.externalId(id)
        const note = await store.notes.fileNote(selected.id, path)
        const retired = note ? undefined : await store.catalog.get(selected.id, path, true)
        const ref = note?.ref ?? retired?.ref
        if (ref) await stale(ref)
        await store.notes.deleteFileNotes(selected.id, [path], reason)
      }
    },
    prune: async (principal: string, before: string) => {
      const selected = await folder(principal, false)
      return selected ? store.notes.pruneDocumentHistory?.(selected.id, before) : undefined
    },
    /** The profile's local history: earlier versions of a document and what changed when. */
    history: {
      /** `id` is the source's id, or a `document:<n>` ref; a removed document is found too. */
      reference: async (principal: string, id: string) => {
        const selected = await folder(principal, false)
        if (!selected) return undefined
        if (/^document:\d+$/.test(id)) {
          const path = await store.notes.documentHistory(id).then(
            (found) => found.path,
            () => undefined,
          )
          return path !== undefined && (await store.notes.documentAt(selected.id, path)) === id ? id : undefined
        }
        for (const path of both(id)) {
          const found = await store.notes.documentAt(selected.id, path)
          if (found) return found
        }
        return undefined
      },
      versions: (reference: string) => store.notes.documentHistory(reference),
      version: (reference: string, revision: number) => store.notes.documentVersion(reference, revision),
      changes: async (principal: string, query: Parameters<MessageStore["notes"]["documentChanges"]>[1]) => {
        const selected = await folder(principal, false)
        return selected ? store.notes.documentChanges(selected.id, query) : { items: [], hasMore: false }
      },
    },
  }
}
