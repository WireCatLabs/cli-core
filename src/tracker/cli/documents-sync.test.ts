import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError, captureStreams, memoryKeyring } from "@wirecat/cli-base"
import { describeProgram } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { documentLibrary } from "../../cli/documents/library.js"
import { documentCommandsContract, FAKE_FOLDER, fakeDocumentSource } from "../../cli/documents/testing/index.js"
import type { DocumentWords } from "../../cli/documents/words.js"
import { commandPermissions } from "../../cli/permission-keys.js"
import { createProgram, type ProgramDefinition, run } from "../../cli/program.js"
import { settingsFor } from "../../cli/settings.js"
import { documentIngestion, type FeedlessDocumentSource, type SourceFile } from "../../documents.js"
import { toolsFromCommands } from "../../mcp/agent.js"
import { searchAll } from "../../services/search-all.js"
import { type MessageStore, openStore } from "../../store/store.js"
import type { TrackerSource } from "../source.js"
import { exampleTrackerRows, fakeTrackerSource } from "../testing/index.js"
import { addTrackerCommands } from "./index.js"

const app = {
  command: "lin",
  appName: "lin-cli",
  envPrefix: "LIN",
  description: "a synthetic tracker with documents",
  version: "1.0.0",
  messenger: false,
}
const provider = {
  name: "linear",
  kind: "tracker",
  kinds: ["tracker", "documents"],
  aliases: [],
  command: "lin",
} as const
const WORDS: DocumentWords = { app: "lin", remote: "linear", provider: "Linear", source: provider.name }
const ACCOUNT = { provider: "linear", account: "alpha" }
const isFolder = (file: SourceFile) => file.mime === FAKE_FOLDER

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const setup = (
  options: { tracker?: () => TrackerSource; documents?: FeedlessDocumentSource; signedIn?: boolean } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "tracker-documents-"))
  const env: NodeJS.ProcessEnv = {
    MESSAGING_STORE: join(root, "wirecat.db"),
    LIN_STATE_DIR: join(root, "state"),
    LIN_CONFIG_DIR: join(root, "config"),
    LIN_CACHE_DIR: join(root, "cache"),
  }
  const tracker = fakeTrackerSource({ rows: exampleTrackerRows(), self: "user-1" })
  const documents = options.documents ?? fakeDocumentSource("alpha")
  const definition = (): ProgramDefinition => {
    const configuration = settingsFor(app, { permissions: commandPermissions() })
    return {
      app,
      configuration,
      commands: () => {
        const library = documentLibrary<SourceFile>({
          app,
          resolveSettings: configuration.resolveSettings,
          provider,
          words: WORDS,
          service: "Linear",
          source: () => documents,
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
          coverage: "the chosen projects",
        })
        const holder = new Command(app.command)
        addTrackerCommands(holder, {
          app,
          now: () => Date.UTC(2026, 10, 17),
          documents: library.sync,
          open: async () => {
            if (options.signedIn === false)
              throw new CliError("authentication_error", "personal is not signed in", { reason: "auth.missing" })
            const store = await openStore({ path: String(env.MESSAGING_STORE), env })
            return { account: ACCOUNT, store, source: options.tracker ?? (() => tracker), close: () => store.close() }
          },
        })
        return [...library.commands, ...holder.commands]
      },
    }
  }
  const cli = async (argv: string[]) => {
    const streams = captureStreams()
    const words = argv[0] === "--bare" ? argv.slice(1) : ["personal", ...argv]
    const exit = await run([...words, "--json"], definition(), {
      streams,
      tty: false,
      env,
      keyring: memoryKeyring(),
    })
    return { exit, stdout: streams.stdout.join(""), stderr: streams.stderr.join("\n") }
  }
  const answer = async (argv: string[]) => {
    const done = await cli(argv)
    if (!done.stdout) throw new Error(done.stderr)
    return { exit: done.exit, ...JSON.parse(done.stdout) }
  }
  const store = async () => {
    const one = await openStore({ path: String(env.MESSAGING_STORE), env })
    opened.push(one)
    return one
  }
  return { program: createProgram(definition()), cli, answer, store, env }
}

describe("one sync for a tracker that holds documents too", () => {
  for (const c of documentCommandsContract(async () => {
    const { program, cli } = setup()
    expect((await cli(["folders", "add", "root"])).exit).toBe(0)
    return { program, words: WORDS, run: cli, document: "a", word: "quarterly" }
  }))
    it(c.name, c.run)

  it("mounts the tracker's commands beside the documents' status, with the permission keys of each", () => {
    const { program } = setup()
    const names = program.commands.map((one) => one.name())
    expect(names.filter((name) => name === "sync")).toHaveLength(1)
    expect(names).toEqual(expect.arrayContaining(["status", "issues", "projects", "documents", "folders"]))
  })

  it("brings issues and documents, the tracker's report on top and the documents' under documents", async () => {
    const { cli, answer, store } = setup()
    await cli(["folders", "add", "root"])
    const synced = await answer(["sync"])
    expect(synced.exit).toBe(0)
    expect(synced.item).toMatchObject({
      account: "alpha",
      state: "complete",
      complete: true,
      tasks: { opened: 1 },
      documents: { errors: [], pending: 0, saved: 2 },
    })
    expect(synced.item.synced.map((one: { kind: string }) => one.kind)).toContain("issue")
    expect(synced.meta.complete).toBe(true)
    expect(synced.next).toBeUndefined()

    const found = await searchAll(
      await store(),
      { provider: "telegram", account: "1" },
      {
        text: "quarterly",
        limit: 20,
        only: ["notes", "tracker"],
      },
    )
    expect(found.items.map(({ kind }) => kind)).toContain("document")
    const lanes = found.accounts.filter(({ account }) => account !== "internal")
    expect(lanes.map(({ resource }) => resource).sort()).toEqual(["notes", "tracker"])
  })

  it("answers the documents when the tracker part fails, and names the failure", async () => {
    const { cli, answer } = setup({
      tracker: () => {
        throw new CliError("provider_unavailable", "the tracker is down", { reason: "provider.down" })
      },
    })
    await cli(["folders", "add", "root"])
    const synced = await answer(["sync"])
    expect(synced.exit).toBe(0)
    expect(synced.item).toMatchObject({
      complete: false,
      synced: [],
      error: { code: "provider_unavailable", reason: "provider.down" },
      documents: { saved: 2 },
    })
    expect(synced.meta).toMatchObject({
      complete: false,
      issues: [{ code: "provider_unavailable", reason: "provider.down", source: "tracker" }],
    })
  })

  it("answers the tracker when the documents part fails, and names the failure", async () => {
    const documents = fakeDocumentSource("alpha")
    documents.identity = async () => {
      throw new CliError("authentication_error", "the documents token was revoked", { reason: "auth.revoked" })
    }
    const { cli, answer } = setup({ documents })
    await cli(["folders", "add", "root"])
    const synced = await answer(["sync"])
    expect(synced.exit).toBe(0)
    expect(synced.item).toMatchObject({
      state: "complete",
      complete: false,
      tasks: { opened: 1 },
      documents: { error: { code: "authentication_error", reason: "auth.revoked" } },
    })
    expect(synced.meta.issues).toEqual([{ code: "authentication_error", reason: "auth.revoked", source: "documents" }])
  })

  it("fails as the tracker does when neither part can run", async () => {
    const documents = fakeDocumentSource("alpha")
    documents.identity = async () => {
      throw new CliError("authentication_error", "not signed in", { reason: "auth.missing" })
    }
    const { cli } = setup({ signedIn: false, documents })
    await cli(["folders", "add", "root"])
    const done = await cli(["sync"])
    expect(done.exit).not.toBe(0)
    expect(done.stdout).toBe("")
    expect(JSON.parse(done.stderr).error).toMatchObject({
      code: "authentication_error",
      message: "personal is not signed in; the documents failed too (auth.missing): not signed in",
    })
  })

  it("fails as the tracker does when it cannot run and no folder is chosen", async () => {
    const { cli } = setup({ signedIn: false })
    const done = await cli(["sync"])
    expect(done.exit).not.toBe(0)
    expect(done.stdout).toBe("")
    expect(JSON.parse(done.stderr).error).toMatchObject({
      code: "authentication_error",
      message: "personal is not signed in",
    })
  })

  it("skips the documents, asking nothing, while no folder is chosen and nothing is kept", async () => {
    const documents = fakeDocumentSource("alpha")
    let asked = 0
    const identity = documents.identity
    documents.identity = async () => {
      asked += 1
      return identity()
    }
    const { answer, env } = setup({ documents })
    const synced = await answer(["sync"])
    expect(synced.item).toMatchObject({
      state: "complete",
      complete: true,
      documents: { skipped: "no folders chosen" },
    })
    expect(synced.meta.complete).toBe(true)
    expect(asked).toBe(0)
    const kept = readdirSync(String(env.LIN_STATE_DIR), { recursive: true, encoding: "utf8" })
    expect(kept.filter((path) => path.includes("state.json") || path.includes("account"))).toEqual([])
  })

  it("refuses documents signed in as another account than the tracker's, and stores nothing for it", async () => {
    const { cli, answer, store } = setup({ documents: fakeDocumentSource("beta") })
    await cli(["folders", "add", "root"])
    const synced = await answer(["sync"])
    expect(synced.item).toMatchObject({
      state: "complete",
      documents: { error: { code: "configuration_error", reason: "documents.other-account" } },
    })
    expect(synced.meta.issues).toEqual([
      { code: "configuration_error", reason: "documents.other-account", source: "documents" },
    ])
    const linear = (await (await store()).accounts.storedAccounts()).filter(({ provider }) => provider === "linear")
    expect(linear.map(({ account }) => account)).toEqual(["alpha"])
  })

  it("names a failed document as the documents part's, a partial answer that exits 0", async () => {
    const documents = fakeDocumentSource("alpha")
    const content = documents.content
    documents.content = async (id, maxChars) => {
      if (id === "a") throw new CliError("provider_error", "Linear answered 500", { reason: "provider.failed" })
      return content(id, maxChars)
    }
    const { cli, answer } = setup({ documents })
    await cli(["folders", "add", "root"])
    const synced = await answer(["sync"])
    expect(synced.exit).toBe(0)
    expect(synced.meta.complete).toBe(false)
    expect(synced.meta.issues.length).toBeGreaterThan(0)
    expect(new Set(synced.meta.issues.map(({ source }: { source: string }) => source))).toEqual(new Set(["documents"]))
  })

  it("answers with the run that holds the tracker's requests, the documents' kept as a run of their own", async () => {
    const { cli, answer, env } = setup()
    await cli(["folders", "add", "root"])
    const synced = await answer(["sync", "--record"])
    const runs = join(String(env.LIN_STATE_DIR), "runs")
    const recorded = readdirSync(runs, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith("run.json"))
      .map((path) => JSON.parse(readFileSync(join(runs, path), "utf8")) as { run_id: string; command: string })
    expect(recorded.map(({ command }) => command).sort()).toEqual(["sync", "sync documents"])
    expect(recorded.find(({ command }) => command === "sync")?.run_id).toBe(synced.meta.run_id)
  })

  it("gives an agent one sync tool, with the flags it takes and without the refused --limit", () => {
    const tools = toolsFromCommands(describeProgram(setup().program)).filter((tool) => tool.path.join(" ") === "sync")
    expect(tools).toHaveLength(1)
    expect(Object.keys(tools[0]?.input.entries ?? {})).toEqual(expect.arrayContaining(["rescan", "max_pages", "embed"]))
    expect(Object.keys(tools[0]?.input.entries ?? {})).not.toContain("limit")
    expect(tools[0]?.output).toBeDefined()
  })

  it("refuses --limit, which would count documents only, with the reason", async () => {
    const { cli } = setup()
    const done = await cli(["sync", "--limit", "5"])
    expect(done.exit).not.toBe(0)
    expect(done.stderr).toContain("--max-pages bounds both parts")
  })

  it("keeps the tracker's report when --embed finds no model, naming the embedding as its own issue", async () => {
    const { answer, env } = setup()
    env.WIRECAT_STATE_DIR = join(String(env.LIN_STATE_DIR), "wirecat")
    const synced = await answer(["sync", "--embed"])
    expect(synced.exit).toBe(0)
    expect(synced.item).toMatchObject({ state: "complete", complete: false, tasks: { opened: 1 } })
    expect(synced.item.embeddings).toBeUndefined()
    expect(synced.meta.issues).toContainEqual({
      code: "not_found",
      reason: "model.not-downloaded",
      source: "tracker:embeddings",
    })
  })

  it("goes on with one step when --max-pages stops a part, passing it and --timeout on", async () => {
    const { cli, answer } = setup()
    await cli(["folders", "add", "root"])
    const synced = await answer(["sync", "--max-pages", "1", "--timeout", "5m"])
    expect(synced.meta.complete).toBe(false)
    expect(synced.item.complete).toBe(false)
    expect(synced.next).toEqual([
      expect.objectContaining({
        step: "tracker.sync",
        command: "sync",
        args: { max_pages: 1, timeout: "5m" },
        safe_to_auto_execute: true,
      }),
    ])
  })
})
