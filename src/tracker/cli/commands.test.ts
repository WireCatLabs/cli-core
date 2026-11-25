import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { provide } from "../../cli/context.js"
import type { AppIdentity } from "../../ports/app.js"
import { type MessageStore, openStore } from "../../store/store.js"
import type { TrackerSource } from "../source.js"
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

const setup = async (wrap: (source: TrackerSource) => TrackerSource = (source) => source) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "tracker-cli-")), "store.db") })
  opened.push(store)
  const source = wrap(fakeTrackerSource({ rows: exampleTrackerRows(), self: "user-1" }))
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
    expect((await cli("sync")).item).toMatchObject({
      state: "complete",
      provider: "fake-tracker",
      tasks: { opened: 1, closed: 0, reopened: 0, renamed: 0 },
    })

    expect(ids(await cli("issues", "list", "type:started"))).toEqual(["issue-1"])
    expect(ids(await cli("issues", "list", "type:unstarted"))).toEqual(["issue-2"])
    expect(ids(await cli("issues", "list", "type:started", "type:unstarted"))).toEqual(["issue-2", "issue-1"])
    expect(ids(await cli("issues", "list", "assignee:None"))).toEqual(["issue-3"])
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
    const stored = await store.tasks.query("fake-tracker:workspace", undefined, { limit: 10, offset: 0 })
    expect(stored.map((one) => [one.title, one.task.source, one.task.origin])).toEqual([
      ["ENG-1 Invoices fail for EUR accounts", "tracker:issue/issue-1", "rule"],
      ["ENG-2 Write the migration guide", "tracker:issue/issue-2", "owner"],
    ])
    expect(stored[1]?.task).not.toHaveProperty("description")
    expect((await cli("sync")).item).toMatchObject({ tasks: { opened: 0, closed: 0, reopened: 0, renamed: 0 } })

    expect(ids(await cli("states", "list", "--limit", "10"))).toHaveLength(7)
    await expect(cli("issues", "list", "team:a", "team:b")).rejects.toThrow()
    expect(ids(await cli("projects", "list"))).toEqual(["project-1"])
  })

  it("lists sprints, narrows issues by sprint, and says when deletions are next looked for", async () => {
    const { cli } = await setup()
    const synced = await cli("sync")
    expect(synced.item.deletions).toEqual({
      checked: new Date(NOW).toISOString(),
      due: new Date(NOW + 86_400_000).toISOString(),
    })
    expect(synced.meta).not.toHaveProperty("issues")
    expect((await cli("sync")).item.synced).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "issue", saved: 0 })]),
    )
    const [sprint] = (await cli("sprints", "list")).items
    expect(sprint).toMatchObject({ external_id: "sprint-1", number: 1, starts_at: "2026-11-01T00:00:00.000Z" })
    expect(sprint?.untrusted).toEqual(["name", "description"])
    expect(ids(await cli("issues", "list", "sprint:sprint-1"))).toEqual(["issue-1"])
    expect(ids(await cli("issues", "list", "sprint:none")).sort()).toEqual(["issue-2", "issue-3"])
  })

  it("searches a quoted argument as words in any order, a quoted phrase as a phrase, and says it used words only", async () => {
    const { cli } = await setup()
    await cli("sync")
    const any = await cli("issues", "search", "currency invoices")
    expect(ids(any)).toEqual(["issue-1"])
    expect(any.items[0]?.found_by).toEqual(["words"])
    expect(any.missing).toEqual([
      { field: "found_by", why: expect.stringMatching(/^found by words only: .* not downloaded/) },
    ])
    expect(ids(await cli("issues", "search", "currency", "invoices"))).toEqual(["issue-1"])
    expect(ids(await cli("issues", "search", '"currency invoices"'))).toEqual([])
    expect(ids(await cli("issues", "search", '"invoices fail"'))).toEqual(["issue-1"])
    await expect(cli("issues", "search", "from:ada")).rejects.toThrow(/found by the words and meaning/)
  })

  it("narrows issues by a label's, state's, user's, team's, project's or sprint's name, and refuses an unknown one", async () => {
    const { cli } = await setup()
    await cli("sync")
    expect(ids(await cli("issues", "list", "label:bug"))).toEqual(["issue-1"])
    expect(ids(await cli("issues", "list", 'state:"in progress"'))).toEqual(["issue-1"])
    expect(ids(await cli("issues", "list", 'assignee:"ada owner"'))).toEqual(["issue-1"])
    expect(ids(await cli("issues", "list", "assignee:bob@example.com"))).toEqual(["issue-2"])
    expect(ids(await cli("issues", "list", "team:eng", 'project:"billing revamp"', "sprint:1"))).toEqual(["issue-1"])
    expect(ids(await cli("issues", "list", 'sprint:"Sprint 1"'))).toEqual(["issue-1"])
    expect(ids(await cli("issues", "list", "label:label-bug"))).toEqual(["issue-1"])
    const typo = cli("issues", "list", "label:bgu")
    await expect(typo).rejects.toMatchObject({
      code: "validation_error",
      message: expect.stringContaining("no label bgu in the copy; close names: Bug"),
      details: { reason: "tracker.reference", candidates: [{ id: "label-bug", name: "Bug" }] },
    })
    await expect(cli("issues", "list", "state:Shipped")).rejects.toMatchObject({
      details: { reason: "tracker.reference" },
    })
    await expect(cli("issues", "list", "team:Design")).rejects.toThrow(/no team Design in the copy/)
  })

  it("a state's name every team has matches each team's, and team: narrows it to one", async () => {
    const { cli, store } = await setup()
    await cli("sync")
    await store.tracker.save(ACCOUNT, "team", [{ externalId: "team-2", key: "OPS", name: "Operations" }], NOW)
    await store.tracker.save(
      ACCOUNT,
      "state",
      [{ externalId: "state-ops-doing", name: "In Progress", type: "started", team: "team-2" }],
      NOW,
    )
    await store.tracker.save(
      ACCOUNT,
      "issue",
      [
        {
          externalId: "issue-ops",
          key: "OPS-1",
          title: "Rotate keys",
          state: "state-ops-doing",
          team: "team-2",
          labels: [],
        },
      ],
      NOW,
    )
    expect(ids(await cli("issues", "list", 'state:"In Progress"')).sort()).toEqual(["issue-1", "issue-ops"])
    expect(ids(await cli("issues", "list", "team:OPS", 'state:"In Progress"'))).toEqual(["issue-ops"])
    await expect(cli("issues", "list", "state:Doen")).rejects.toMatchObject({
      details: { candidates: [{ id: "state-done", name: "Done", team: "team-1" }] },
    })
  })

  it("names a kind the sign-in could not read in meta.issues, and still answers the sync complete", async () => {
    const { cli } = await setup((source) => ({
      ...source,
      changes: (kind, cursor, page, context) => {
        if (kind === "label") {
          context?.gap({ kind, message: "the key cannot read labels", scope: "read:labels" })
          return Promise.resolve({ items: [], hasMore: false, cursor: null })
        }
        return source.changes(kind, cursor, page, context)
      },
    }))
    const answer = await cli("sync")
    expect(answer.item).toMatchObject({ complete: true, gaps: [{ kind: "label", scope: "read:labels" }] })
    expect(answer.meta).toMatchObject({
      complete: false,
      issues: [{ code: "permission_error", reason: "tracker.kind-unread", source: "tracker:label" }],
    })
  })
})
