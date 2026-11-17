import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { provide } from "../../cli/context.js"
import type { AppIdentity } from "../../ports/app.js"
import { type MessageStore, openStore } from "../../store/store.js"
import { exampleTrackerRows, fakeTrackerSource } from "../testing/index.js"
import { addTrackerCommands } from "./index.js"

const APP: AppIdentity = {
  command: "tracker",
  appName: "example-tracker-cli",
  envPrefix: "TRACKER",
  description: "synthetic",
  version: "1.0.0",
}
const ACCOUNT = { provider: "fake-tracker", account: "workspace" }
const NOW = Date.UTC(2026, 10, 17)

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

type Answer = Record<string, unknown> & { items: Record<string, unknown>[]; item: Record<string, unknown> }

const setup = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "tracker-cli-")), "store.db") })
  opened.push(store)
  const source = fakeTrackerSource({ rows: exampleTrackerRows() })
  const cli = async (...args: string[]): Promise<Answer> => {
    let data = ""
    const root = new Command("tracker")
      .exitOverride()
      .configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
      .option("--json")
    addTrackerCommands(root, {
      app: APP,
      open: async () => ({ account: ACCOUNT, store, source: () => source }),
      now: () => NOW,
    })
    provide(root, { streams: { data: (text: string) => (data += text), diagnostic: () => {} } } as never)
    await root.parseAsync([...args, "--json"], { from: "user" })
    return JSON.parse(data) as Answer
  }
  return { cli, store }
}

const ids = (answer: Answer) => answer.items.map((one) => one.external_id)

describe("tracker commands", () => {
  it("syncs, then lists, shows, searches and assigns an issue to the owner as a task", async () => {
    const { cli, store } = await setup()
    expect((await cli("sync")).item).toMatchObject({ state: "complete", provider: "fake-tracker" })

    expect(ids(await cli("issues", "list", "type:started"))).toEqual(["issue-1"])
    expect(ids(await cli("issues", "list", "type:unstarted"))).toEqual(["issue-2"])
    expect(ids(await cli("issues", "list", "assignee:none"))).toEqual(["issue-3"])
    const [first] = (await cli("issues", "list", "label:label-bug")).items
    expect(first).toMatchObject({
      key: "ENG-1",
      state_name: "In Progress",
      state_type: "started",
      assignee_name: "Ada Owner",
      updated_at: expect.stringMatching(/^2026-11-01T/),
      deleted: false,
    })
    expect(first?.untrusted).toContain("title")

    const shown = (await cli("issues", "show", "eng-1")).item
    expect((shown.comments as Record<string, unknown>[]).map((one) => one.body)).toEqual(["Seen on three accounts"])

    expect(ids(await cli("issues", "search", "provider")).sort()).toEqual(["issue-1", "project-1"])
    const [one] = ids(await cli("issues", "search", "provider", "--limit", "1"))
    const second = await cli("issues", "search", "provider", "--limit", "1", "--page", "2")
    expect(ids(second)).toHaveLength(1)
    expect(ids(second)[0]).not.toBe(one)

    const task = (await cli("issues", "assign", "ENG-2", "--due", "2026-12-01")).item
    expect(task).toMatchObject({ issue: "tracker:issue/issue-2", created: true })
    expect((await cli("issues", "assign", "issue-2")).item).toMatchObject({ task_id: task.task_id, created: false })
    const [stored] = await store.tasks.query("fake-tracker:workspace", undefined, { limit: 10, offset: 0 })
    expect(stored).toMatchObject({ title: "ENG-2", task: { source: "tracker:issue/issue-2" } })
    expect(stored?.task).not.toHaveProperty("description")

    expect(ids(await cli("states", "list", "--limit", "10"))).toHaveLength(6)
    await expect(cli("issues", "list", "team:a", "team:b")).rejects.toThrow()
    expect(ids(await cli("projects", "list"))).toEqual(["project-1"])
  })
})
