import assert from "node:assert/strict"
import { isCliError } from "@wirecat/cli-base"
import type { DocumentSource, SourceFile } from "../../../documents.js"
import type { ContractCase } from "../../../meetings/index.js"

/** One adapter over recorded or faked responses, fresh for each case. */
export interface DocumentSourceFixture<M extends SourceFile = SourceFile> {
  source: DocumentSource<M>
  /** A folder the account can read, with at least one file somewhere below it. */
  root: string
  /** The provider's folder test, as the CLI passes it to `syncDocuments`. */
  isFolder(file: M): boolean
  /** A folder that is also a document (a page with sub-pages), as the CLI passes it to `syncDocuments`. */
  isDocument?(file: M): boolean
  /** Makes a change on the provider's side (a new or edited file) for the change feed to list; absent skips that check. */
  change?(): Promise<void>
  /** An id the provider does not know; absent skips that case. */
  missing?: string
}

const MAX_ENTRIES = 500

const walk = async <M extends SourceFile>({ source, root, isFolder }: DocumentSourceFixture<M>) => {
  const seen = new Map<string, M>()
  const stack = [root]
  while (stack.length) {
    const parent = stack.pop() as string
    for (const child of await source.children(parent)) {
      assert.ok(child.parents.includes(parent), `${child.id} is a child of ${parent} and names it among its parents`)
      if (seen.has(child.id)) continue
      seen.set(child.id, child)
      assert.ok(seen.size <= MAX_ENTRIES, `more than ${MAX_ENTRIES} entries under the fixture's root`)
      if (isFolder(child)) stack.push(child.id)
    }
  }
  return [...seen.values()]
}

/** What the sync imports: a file, or a folder the provider calls a document too. */
const isImported = <M extends SourceFile>(fixture: DocumentSourceFixture<M>, entry: M) =>
  !fixture.isFolder(entry) || fixture.isDocument?.(entry) === true

const isTime = (value: string | undefined) => value === undefined || !Number.isNaN(Date.parse(value))

/** What every documents adapter answers, whatever the provider: run each case in the adapter's tests. */
export const documentSourceContract = <M extends SourceFile>(
  make: () => DocumentSourceFixture<M> | Promise<DocumentSourceFixture<M>>,
): ContractCase[] => {
  const cases: ContractCase[] = [
    {
      name: "identity: the signed-in account, the same on every call",
      async run() {
        const { source } = await make()
        const first = await source.identity()
        assert.equal(typeof first, "string")
        assert.ok(first.trim(), "identity() names the account")
        assert.equal(await source.identity(), first, "identity() does not change between calls")
      },
    },
    {
      name: "metadata: the root is a readable folder under its own id",
      async run() {
        const fixture = await make()
        const root = await fixture.source.metadata(fixture.root)
        assert.equal(root.id, fixture.root)
        assert.ok(fixture.isFolder(root), "the root is a folder")
        assert.equal(root.trashed, false)
      },
    },
    {
      name: "children: every entry has an id, a name, a URL and times that parse, and metadata gives it back",
      async run() {
        const fixture = await make()
        const entries = await walk(fixture)
        assert.ok(
          entries.some((entry) => isImported(fixture, entry)),
          "the root has at least one document below it",
        )
        for (const entry of entries) {
          assert.ok(entry.id && entry.name.trim(), `${entry.id} has an id and a name`)
          assert.equal(typeof entry.url, "string", `${entry.id} has a URL`)
          assert.equal(typeof entry.canDownload, "boolean", `${entry.id} says whether it can be downloaded`)
          assert.ok(isTime(entry.modifiedAt) && isTime(entry.createdAt), `${entry.id}'s times parse`)
          assert.equal((await fixture.source.metadata(entry.id)).id, entry.id, `metadata(${entry.id}) is the same file`)
        }
      },
    },
    {
      name: "content: a document's text, Markdown, tabs and bytes, under its own metadata",
      async run() {
        const fixture = await make()
        const files = (await walk(fixture)).filter((entry) => isImported(fixture, entry) && entry.canDownload)
        assert.ok(files.length > 0, "the root has a file that can be downloaded")
        for (const file of files.slice(0, 5)) {
          const content = await fixture.source.content(file.id)
          assert.equal(content.metadata.id, file.id)
          assert.equal(typeof content.text, "string")
          assert.equal(typeof content.markdown, "string")
          assert.ok(Array.isArray(content.tabs), "tabs is a list, empty for a document without tabs")
          for (const tab of content.tabs)
            assert.ok(typeof tab.id === "string" && typeof tab.title === "string" && typeof tab.text === "string")
          const bytes = await fixture.source.bytes(file.id)
          assert.ok(bytes instanceof Uint8Array, `bytes(${file.id}) is a Uint8Array`)
        }
      },
    },
    {
      name: "changes: a start token, then pages that each give the next cursor and say what was removed",
      async run() {
        const fixture = await make()
        const { source } = fixture
        const token = await source.startToken()
        assert.ok(typeof token === "string" && token, "startToken() gives a cursor")
        await fixture.change?.()
        const page = await source.changes(token)
        assert.ok(Array.isArray(page.items), "a change page has items")
        if (fixture.change) assert.ok(page.items.length > 0, "the change made after startToken() is in the feed")
        assert.ok(typeof page.cursor === "string" && page.cursor, "a change page gives the next cursor")
        for (const item of page.items) {
          assert.equal(typeof item.removed, "boolean", `change ${item.id} says whether it was removed`)
          if (!item.removed && item.file) assert.equal(item.file.id, item.id, `change ${item.id} carries its file`)
        }
      },
    },
  ]
  cases.push({
    name: "metadata: an id the provider does not know is not_found",
    async run() {
      const { source, missing } = await make()
      if (missing === undefined) return
      await assert.rejects(source.metadata(missing), (error) => isCliError(error) && error.code === "not_found")
    },
  })
  return cases
}
