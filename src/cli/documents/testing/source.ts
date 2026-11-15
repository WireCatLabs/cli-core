import { CliError } from "@wirecat/cli-base"
import type { DocumentSource, SourceChange, SourceContent, SourceFile } from "../../../documents.js"

/** The folder type of the fake source: no provider's own. */
export const FAKE_FOLDER = "inode/directory"

export const fakeFile = (id: string, parents: string[] = ["root"], mime = "text/plain"): SourceFile => ({
  id,
  name: id,
  parents,
  mime,
  url: `https://example.invalid/${id}`,
  trashed: false,
  canDownload: true,
  version: "1",
  modifiedAt: "2026-10-16T00:00:00.000Z",
})

export interface FakeDocumentSource extends DocumentSource {
  files: Map<string, SourceFile>
  /** Puts a file or folder in, or changes it, and lists it in the next change feed. */
  put(file: SourceFile, text?: string): void
  /** Takes one out, and lists it as removed in the next change feed. */
  remove(id: string): void
}

/** A provider in memory: a root folder, a nested folder and two text files, with a change feed and a cursor. */
export const fakeDocumentSource = (account = "alpha"): FakeDocumentSource => {
  const files = new Map<string, SourceFile>()
  const texts = new Map<string, string>()
  let feed: SourceChange[] = []
  let cursor = 0
  const metadata = async (id: string) => {
    const found = files.get(id)
    if (!found) throw new CliError("not_found", "no such synthetic file", { reason: "document.not-found" })
    return structuredClone(found)
  }
  const source: FakeDocumentSource = {
    files,
    put(file, text) {
      files.set(file.id, file)
      if (text !== undefined) texts.set(file.id, text)
      feed.push({ id: file.id, removed: false, file: structuredClone(file) })
    },
    remove(id) {
      files.delete(id)
      texts.delete(id)
      feed.push({ id, removed: true })
    },
    identity: async () => account,
    metadata,
    children: async (id) =>
      [...files.values()].filter((item) => item.parents.includes(id)).map((item) => structuredClone(item)),
    startToken: async () => `cursor-${cursor}`,
    changes: async (token) => {
      if (!/^cursor-\d+$/.test(token)) throw new CliError("validation_error", "unknown synthetic cursor")
      const items = feed
      feed = []
      cursor += 1
      return { items, cursor: `cursor-${cursor}` }
    },
    content: async (id, maxChars): Promise<SourceContent> => {
      const file = await metadata(id)
      if (file.mime === FAKE_FOLDER) throw new CliError("validation_error", "a folder has no content")
      const text = (texts.get(id) ?? `budget ${id}`).slice(0, maxChars)
      return { metadata: file, markdown: `# ${file.name}\n\n${text}\n`, text, tabs: [] }
    },
    bytes: async (id) => new TextEncoder().encode((await source.content(id)).text),
  }
  source.put(fakeFile("root", [], FAKE_FOLDER))
  source.put(fakeFile("nested", ["root"], FAKE_FOLDER))
  source.put(fakeFile("a", ["nested"]), "quarterly budget for the alpha team")
  source.put(fakeFile("b"), "notes from the planning review")
  feed = []
  return source
}
