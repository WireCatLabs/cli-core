import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { openStore } from "../../store/store.js"
import { seedSearchRecipes } from "../../testing/search-recipes.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import { storeCommand } from "./archive-commands.js"
import type { Messenger } from "./context.js"
import { messagesCommand } from "./messages-command.js"
import { searchCommand } from "./search-command.js"
import { searchesCommand } from "./searches-command.js"
import { statsCommand } from "./stats-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const messenger: Messenger = {
  app,
  provider: "chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => {
    throw new Error("searches never connect")
  },
  chatArgument: "a chat",
}

/** The search recipes' synthetic fixture: invoice in 101, 102, 106 of chat 7. */
const setup = async (config?: object) => {
  const root = mkdtempSync(join(tmpdir(), "searches-cli-"))
  const env = {
    ...process.env,
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
    NO_COLOR: "1",
  }
  if (config) {
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify(config))
  }
  rememberAccount(app, "default", "500", env)
  const store = await openStore({ path: env.MESSAGING_STORE })
  await seedSearchRecipes(store, { provider: "chat", account: "500" })
  await store.close()
  const runs =
    (tty: boolean) =>
    async (...argv: string[]) => {
      const streams = captureStreams()
      const code = await run(
        argv,
        {
          app,
          commands: () => [
            statsCommand(messenger),
            searchesCommand(messenger),
            messagesCommand(messenger),
            searchCommand(messenger),
            storeCommand(messenger),
          ],
        },
        { streams, tty, env },
      )
      return { code, stdout: streams.stdout, stderr: streams.stderr.join("\n") }
    }
  return Object.assign(runs(false), { pretty: runs(true), root })
}

const json = (result: { stdout: string[] }) => JSON.parse(result.stdout[0] ?? "null")
const ids = (answer: { items: { id: string }[] }) => answer.items.map(({ id }) => id).sort()

describe("searches", () => {
  it("**saves a search, runs it with --saved and more words, and keeps every run in the history**", async () => {
    const call = await setup()
    const saved = json(await call("searches", "create", "invoices", "invoice", "--limit", "2", "--newest", "--json"))
    expect(saved).toMatchObject({ name: "invoices", command: "search", runs: 0, params: { text: "invoice", limit: 2 } })
    expect(json(await call("searches", "history", "--json")).items).toEqual([])

    const first = json(await call("search", "messages", "--saved", "invoices", "--json"))
    expect([first.items.map(({ id }: { id: string }) => id), first.limit, first.hasMore]).toEqual([
      ["106", "102"],
      2,
      true,
    ])
    expect(
      ids(json(await call("search", "messages", "--saved", "invoices", "alpha", "--limit", "5", "--json"))),
    ).toEqual(["101", "106"])
    const stats = json(await call("stats", "messages", "show", "--saved", "invoices", "--by", "sender", "--json"))
    expect(stats.total).toBe(3)

    const history = json(await call("searches", "history", "--json"))
    const runs = history.items.map(
      ({ command, params }: { command: string; params: { text: string } }) => `${command} ${params.text}`,
    )
    expect(runs[0]).toBe("stats invoice")
    expect(runs.sort()).toEqual(["search (invoice) AND (alpha)", "search invoice", "search invoice", "stats invoice"])
    expect(history.items.find(({ name }: { name: string | null }) => name === "invoices").runs).toBe(3)
    expect(json(await call("searches", "list", "--json"))).toMatchObject({
      items: [{ name: "invoices" }],
      hasMore: false,
    })
    expect(json(await call("searches", "show", "invoices", "--json")).runs).toBe(3)

    expect(json(await call("searches", "clear", "--json"))).toEqual({ cleared: 3 })
    expect(json(await call("searches", "delete", "invoices", "--json")).name).toBe("invoices")
    expect(json(await call("searches", "list", "--json")).items).toEqual([])
  })

  it("**a backup keeps the saved searches**", async () => {
    const call = await setup()
    await call("searches", "create", "invoices", "invoice", "--json")
    const file = join(call.root, "backup.db")
    expect((await call("store", "backup", file, "--json")).code).toBe(0)
    await call("searches", "delete", "invoices", "--json")
    expect((await call("store", "restore", file, "--json")).code).toBe(0)
    expect(ids(json(await call("search", "messages", "--saved", "invoices", "--json")))).toEqual(["101", "102", "106"])
  })

  it("keeps no history with --no-record, and none of a refused query", async () => {
    const call = await setup()
    expect((await call("search", "messages", "invoice", "--no-record", "--json")).code).toBe(0)
    expect((await call("search", "messages", "foo:bar", "--json")).code).toBe(2)
    expect(json(await call("searches", "history", "--json")).items).toEqual([])
  })

  it("names the saved search when its stored query no longer parses, and refuses what cannot be saved", async () => {
    const call = await setup()
    expect((await call("search", "messages", "--json")).stderr).toContain("--saved <name>")
    expect((await call("search", "messages", "--saved", "nothing", "--json")).code).toBe(6)
    const typo = await call("searches", "create", "typo", "foo:bar", "--json")
    expect([typo.code, typo.stdout]).toEqual([2, []])
    expect((await call("searches", "create", "123", "invoice", "--json")).stderr).toContain(
      "cannot name a saved search",
    )
    await call("searches", "create", "pattern", "inv.ice", "--regex", "--json")
    expect((await call("stats", "messages", "show", "--saved", "pattern", "--json")).stderr).toContain("legacy")
    expect((await call("search", "messages", "--saved", "pattern", "--regex", "--json")).code).toBe(2)
    expect(ids(json(await call("search", "messages", "--saved", "pattern", "--json")))).toEqual(["101", "102", "106"])
    expect((await call("searches", "create", "pattern", "x", "--json")).stderr).toContain("--replace")
  })

  it("prints for a person", async () => {
    const call = (await setup()).pretty
    expect((await call("searches", "list")).stderr).toContain("no saved searches")
    expect((await call("searches", "history")).stderr).toContain("no searches ran yet")
    expect((await call("searches", "create", "invoices", "invoice")).stdout.join("")).toContain(
      'invoices  search  "invoice"',
    )
    await call("search", "messages", "--saved", "invoices")
    expect((await call("searches", "history", "--limit", "1")).stdout.join("")).toContain("1 runs")
    expect((await call("searches", "list")).stdout.join("")).toContain("invoices")
    expect((await call("searches", "clear")).stdout.join("")).toContain("1 runs cleared")
    expect((await call("searches", "delete", "invoices")).stdout.join("")).toContain("deleted invoices")
  })

  it("**writes nothing where searches are read-only**, and still lists", async () => {
    const call = await setup({ profiles: { default: { permissions: { searches: "readonly" } } } })
    const refused = await call("searches", "create", "invoices", "invoice", "--json")
    expect([refused.code, refused.stdout]).toEqual([5, []])
    expect(refused.stderr).toContain("permissions.searches.create allow")
    expect((await call("searches", "clear", "--json")).code).toBe(5)
    expect((await call("searches", "delete", "x", "--json")).code).toBe(5)
    expect((await call("searches", "list", "--json")).code).toBe(0)
  })
})
