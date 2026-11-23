import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams, type KeyringStore, memoryKeyring } from "@wirecat/cli-base"
import { describeProgram } from "@wirecat/cli-base/commands"
import { describe, expect, it } from "vitest"
import { documentIngestion, type FeedlessDocumentSource, type SourceFile } from "../../documents.js"
import { toolsFromCommands } from "../../mcp/agent.js"
import { commandPermissions } from "../permission-keys.js"
import { createProgram, type ProgramDefinition, run } from "../program.js"
import { settingsFor } from "../settings.js"
import { DOCUMENT_HISTORY_SETTINGS, keepVersionsForDays } from "./history.js"
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

const definition = (source: FeedlessDocumentSource, words: DocumentWords = WORDS): ProgramDefinition => {
  const configuration = settingsFor(app, { permissions: commandPermissions(), ...DOCUMENT_HISTORY_SETTINGS })
  return {
    app,
    configuration,
    commands: () =>
      documentLibraryCommands<SourceFile>({
        app,
        resolveSettings: configuration.resolveSettings,
        provider,
        words,
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
        folder: (source, input) =>
          input.startsWith("/") && "byPath" in source
            ? (source as unknown as { byPath(path: string): Promise<SourceFile> }).byPath(input)
            : source.metadata(input),
        isFolder,
        folderPath: (file) => `/${file.name}`,
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
  words: DocumentWords = WORDS,
) => {
  const root = mkdtempSync(join(tmpdir(), "documents-library-"))
  const env: NodeJS.ProcessEnv = {
    MESSAGING_STORE: join(root, "wirecat.db"),
    BOX_STATE_DIR: join(root, "state"),
    BOX_CONFIG_DIR: join(root, "config"),
    BOX_CACHE_DIR: join(root, "cache"),
  }
  const program = createProgram(definition(source, words))
  const cli = async (argv: string[]) => {
    const streams = captureStreams()
    const args = argv[0] === "--as" ? argv.slice(1) : ["personal", ...argv]
    const exit = await run([...args, "--json"], definition(source, words), {
      streams,
      tty: false,
      env,
      ...(keyring ? { keyring } : {}),
    })
    return { exit, stdout: streams.stdout.join(""), stderr: streams.stderr.join("\n") }
  }
  return { source, program, cli, env }
}

describe("documentLibraryCommands over a source without a change feed", () => {
  it("shows a document's earlier versions and what changed, a page the source no longer lists kept", async () => {
    const { source, cli } = setup(fakeDocumentSource("alpha", { feed: false }), memoryKeyring())
    await cli(["folders", "add", "root"])
    await cli(["sync"])
    source.put({ ...source.files.get("a"), version: "2" } as SourceFile, "a new budget line")
    source.remove("b")
    await cli(["sync"])
    const shown = await cli(["documents", "history", "a"])
    if (!shown.stdout) throw new Error(shown.stderr)
    const history = JSON.parse(shown.stdout).item
    expect(history.versions.map((one: { current: boolean; reason: string }) => [one.current, one.reason])).toEqual([
      [true, "edited"],
      [false, "edited"],
    ])
    const read = await cli(["documents", "history", "a", "--revision", "1"])
    if (!read.stdout) throw new Error(read.stderr)
    const old = JSON.parse(read.stdout).item
    expect(old.text).not.toContain("a new budget line")
    expect(JSON.parse((await cli(["documents", "history", "b"])).stdout).item).toMatchObject({ removal: "unavailable" })
    const changes = JSON.parse((await cli(["changes", "--since", "2020-01-01T00:00:00Z"])).stdout).items
    expect(changes.map((one: { path: string; event: string }) => [one.path, one.event])).toEqual(
      expect.arrayContaining([
        ["a.md", "changed"],
        ["b.md", "unavailable"],
      ]),
    )
    const only = JSON.parse((await cli(["changes", "--since", "1d", "--event", "unavailable"])).stdout).items
    expect(only.map((one: { path: string }) => one.path)).toEqual(["b.md"])
    expect((await cli(["documents", "history", "missing"])).exit).not.toBe(0)
  })

  it("gives an agent the history and the change log as read tools", () => {
    const tools = toolsFromCommands(describeProgram(setup().program)).map((tool) => tool.path.join(" "))
    expect(tools).toEqual(expect.arrayContaining(["documents history", "changes"]))
  })

  it("takes keep_versions_for_days from the config file", async () => {
    const { cli, env } = setup(fakeDocumentSource("alpha", { feed: false }), memoryKeyring())
    mkdirSync(String(env.BOX_CONFIG_DIR), { recursive: true })
    writeFileSync(
      join(String(env.BOX_CONFIG_DIR), "config.json"),
      JSON.stringify({ defaults: { keep_versions_for_days: 30 }, profiles: {} }),
    )
    expect((await cli(["folders", "add", "root"])).exit).toBe(0)
    expect((await cli(["sync"])).exit).toBe(0)
    const configuration = settingsFor(app, { permissions: commandPermissions(), ...DOCUMENT_HISTORY_SETTINGS })
    const read = (profiles: object) => {
      writeFileSync(join(String(env.BOX_CONFIG_DIR), "config.json"), JSON.stringify(profiles))
      return keepVersionsForDays(
        configuration.resolveSettings({ profile: "personal" }, { env, configDir: String(env.BOX_CONFIG_DIR) }),
      )
    }
    expect(read({ defaults: { keep_versions_for_days: 30 }, profiles: {} })).toBe(30)
    expect(read({ defaults: {}, profiles: { personal: { keep_versions_for_days: 7 } } })).toBe(7)
    expect(read({ profiles: {} })).toBe(365)
  })

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
    expect(JSON.parse((await cli(["folders", "list"])).stdout).items).toEqual([
      { id: "root", name: "root", path: "/root" },
    ])
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

  it("finds a chosen folder moved on a path-addressed provider once it is added again under its new path", async () => {
    const inner = fakeDocumentSource("alpha", { feed: false })
    const pathOf = (id: string): string => {
      const file = inner.files.get(id)
      if (!file) return ""
      const parent = file.parents[0]
      return parent ? `${pathOf(parent)}/${file.name}` : `/${file.name}`
    }
    const withPath = (file: SourceFile) => ({ ...file, providerMetadata: { path: pathOf(file.id) } })
    // Reads only by the path it was given, as Yandex Disk does.
    const reach = (id: string, known?: SourceFile) => {
      const path = (known?.providerMetadata as { path?: string } | undefined)?.path
      if (!path || pathOf(id) !== path) throw new CliError("not_found", "nothing at that path")
    }
    const source = {
      identity: () => inner.identity(),
      byPath: async (path: string) => {
        const found = [...inner.files.values()].find((file) => pathOf(file.id) === path)
        if (!found) throw new CliError("not_found", "nothing at that path")
        return withPath(found)
      },
      metadata: async (id: string, known?: SourceFile) => {
        reach(id, known)
        return withPath(await inner.metadata(id))
      },
      children: async (id: string, folder?: SourceFile) => {
        reach(id, folder)
        return (await inner.children(id)).map(withPath)
      },
      content: async (id: string, max?: number, file?: SourceFile) => {
        reach(id, file)
        return inner.content(id, max)
      },
      bytes: (id: string) => inner.bytes(id),
    }
    const { cli } = setup(source)
    expect((await cli(["folders", "add", "/root"])).exit).toBe(0)
    expect(JSON.parse((await cli(["sync"])).stdout).item).toMatchObject({ saved: 2 })
    inner.files.set("root", { ...(inner.files.get("root") as SourceFile), name: "moved" })
    expect(JSON.parse((await cli(["sync"])).stdout).item).toMatchObject({ removed: 2 })
    expect((await cli(["folders", "add", "/moved"])).exit).toBe(0)
    expect(JSON.parse((await cli(["sync"])).stdout).item).toMatchObject({ saved: 2 })
  })

  it("refuses a file as a folder, and a list or search before the first sync says to sync", async () => {
    const { cli } = setup()
    const file = await cli(["folders", "add", "a"])
    expect(file.exit).not.toBe(0)
    expect(file.stdout + file.stderr).toContain("choose a folder")
    const listed = await cli(["documents", "list"])
    expect(listed.stdout + listed.stderr).toContain("box personal sync")
  })

  it("names what folders add takes, in its example and in the hint before any folder is chosen", async () => {
    const { cli } = setup(undefined, undefined, { ...WORDS, text: { folderToAdd: "/Documents" } })
    const help = await cli(["folders", "add", "--help"])
    expect(help.stdout).toContain("box personal folders add /Documents")
    expect(help.stdout).not.toContain("FOLDER_ID")
    for (const step of [["folders", "add", "root"], ["sync"], ["folders", "remove", "root"], ["sync"]])
      expect((await cli(step)).exit).toBe(0)
    const search = await cli(["search", "quarterly"])
    expect(search.stdout).toContain("box personal folders add /Documents, then box personal sync")
  })
})
