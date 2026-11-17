import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams, type KeyringStore, memoryKeyring } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { documentIngestion, type FeedlessDocumentSource, type SourceFile } from "../../documents.js"
import { commandPermissions } from "../permission-keys.js"
import { createProgram, type ProgramDefinition, run } from "../program.js"
import { settingsFor } from "../settings.js"
import { documentLibraryCommands } from "./library.js"
import { documentCommandsContract, FAKE_FOLDER, type FakeDocumentSource, fakeDocumentSource } from "./testing/index.js"
import type { DocumentWords } from "./words.js"

const app = {
  command: "box",
  appName: "box-cli",
  envPrefix: "BOX",
  description: "a synthetic documents CLI",
  version: "1.0.0",
  messenger: false,
}
const provider = { name: "synthetic-box", kind: "documents", aliases: [], command: "box" } as const
const WORDS: DocumentWords = { app: "box", remote: "box", provider: "Box", source: provider.name }
const isFolder = (file: SourceFile) => file.mime === FAKE_FOLDER

const definition = (source: FeedlessDocumentSource): ProgramDefinition => {
  const configuration = settingsFor(app, { permissions: commandPermissions() })
  return {
    app,
    configuration,
    commands: () =>
      documentLibraryCommands<SourceFile>({
        app,
        resolveSettings: configuration.resolveSettings,
        provider,
        words: WORDS,
        service: "Box",
        source: () => source,
        ingestion: (store) =>
          documentIngestion<SourceFile>(store, {
            provider: provider.name,
            externalId: (id) => `${id}.md`,
            catalogInput: (file) => ({
              externalId: `${file.id}.md`,
              name: file.name,
              parents: file.parents.map((id) => `${id}.md`),
              kind: isFolder(file) ? "folder" : "file",
              url: file.url,
              mime: file.mime,
            }),
            frontMatter: (content) => ({ source: provider.name, sourceUrl: content.metadata.url }),
          }),
        idOf: (input) => input,
        isFolder,
        row: (file, reference) => ({ id: file.id, name: file.name, url: file.url, reference }),
        textLimit: 100_000,
        maxEntries: 1_000,
        coverage: "the chosen folders",
      }),
  }
}

const setup = <S extends FeedlessDocumentSource = FakeDocumentSource>(
  source: S = fakeDocumentSource("alpha", { feed: false }) as unknown as S,
  keyring?: KeyringStore,
) => {
  const root = mkdtempSync(join(tmpdir(), "documents-library-"))
  const env: NodeJS.ProcessEnv = {
    MESSAGING_STORE: join(root, "wirecat.db"),
    BOX_STATE_DIR: join(root, "state"),
    BOX_CONFIG_DIR: join(root, "config"),
    BOX_CACHE_DIR: join(root, "cache"),
  }
  const program = createProgram(definition(source))
  const cli = async (argv: string[]) => {
    const streams = captureStreams()
    const words = argv[0] === "--as" ? argv.slice(1) : ["personal", ...argv]
    const exit = await run([...words, "--json"], definition(source), {
      streams,
      tty: false,
      env,
      ...(keyring ? { keyring } : {}),
    })
    return { exit, stdout: streams.stdout.join(""), stderr: streams.stderr.join("\n") }
  }
  return { source, program, cli }
}

describe("documentLibraryCommands over a source without a change feed", () => {
  for (const c of documentCommandsContract(async () => {
    const { program, cli } = setup()
    expect((await cli(["folders", "add", "root"])).exit).toBe(0)
    return { program, words: WORDS, run: cli, document: "a", word: "quarterly" }
  }))
    it(c.name, c.run)

  it("keeps the chosen folder, finds an edit and a removal on the next sync, and keeps a second account out", async () => {
    const { source, cli } = setup()
    expect(JSON.parse((await cli(["folders", "add", "root"])).stdout)).toMatchObject({
      item: { id: "root", added: true },
    })
    expect(JSON.parse((await cli(["folders", "list"])).stdout).items).toEqual([{ id: "root" }])
    expect(JSON.parse((await cli(["sync"])).stdout).item).toMatchObject({ saved: 2, removed: 0 })
    source.put({ ...source.files.get("a"), version: "2" } as SourceFile, "a new budget line")
    source.remove("b")
    expect(JSON.parse((await cli(["sync"])).stdout).item).toMatchObject({ saved: 1, removed: 1 })
    const found = JSON.parse((await cli(["search", "line"])).stdout)
    expect(JSON.stringify(found)).toContain('"a"')
    expect(JSON.parse((await cli(["status"])).stdout).item).toMatchObject({ documents: 1, selected_folders: ["root"] })
    const refused = await cli(["folders", "remove", "nested"])
    expect(refused.exit).not.toBe(0)
    expect(refused.stdout + refused.stderr).toContain("is not a chosen folder")
  })

  it("keeps one provider account to one signed-in profile", async () => {
    const { cli } = setup(
      fakeDocumentSource("alpha", { feed: false }),
      memoryKeyring({ "box-cli:token:personal": "x" }),
    )
    expect((await cli(["folders", "add", "root"])).exit).toBe(0)
    expect((await cli(["sync"])).exit).toBe(0)
    expect((await cli(["--as", "work", "folders", "add", "root"])).exit).toBe(0)
    const taken = await cli(["--as", "work", "sync"])
    expect(taken.exit).not.toBe(0)
    expect(taken.stdout + taken.stderr).toContain("already uses this account")
  })

  it("serves a source written as a class, its private fields and missing feed included", async () => {
    const inner = fakeDocumentSource("alpha", { feed: false })
    class Box {
      readonly #inner = inner
      identity() {
        return this.#inner.identity()
      }
      metadata(id: string, known?: SourceFile) {
        return this.#inner.metadata(id, known)
      }
      children(id: string, folder?: SourceFile) {
        return this.#inner.children(id, folder)
      }
      content(id: string, max?: number, file?: SourceFile) {
        return this.#inner.content(id, max, file)
      }
      bytes(id: string, file?: SourceFile) {
        return this.#inner.bytes(id, file)
      }
    }
    const { cli } = setup(new Box())
    expect((await cli(["folders", "add", "root"])).exit).toBe(0)
    const synced = await cli(["sync"])
    expect(synced.exit, synced.stderr).toBe(0)
    expect(JSON.parse(synced.stdout).item).toMatchObject({ saved: 2 })
  })

  it("refuses a file as a folder, and a list or search before the first sync says to sync", async () => {
    const { cli } = setup()
    const file = await cli(["folders", "add", "a"])
    expect(file.exit).not.toBe(0)
    expect(file.stdout + file.stderr).toContain("choose a folder")
    const listed = await cli(["documents", "list"])
    expect(listed.stdout + listed.stderr).toContain("box personal sync")
  })
})
