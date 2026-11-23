import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { serviceApiCall } from "../../cli/service-api-call.js"
import { FAKE_MANIFEST_TOKEN } from "../../crm/testing/index.js"
import { openStore } from "../../store/store.js"
import { ALL, api, definitions, MANIFEST, PAGE_INFO } from "../../testing/tracker-graphql.js"
import type { TrackerManifest } from "../manifest/manifest.js"
import { syncTracker } from "../sync.js"
import { trackerManifestContract, trackerManifestFake, trackerManifestFixture } from "./manifest-fake.js"

type Row = Record<string, unknown>

const fakeOf = (manifest: TrackerManifest = MANIFEST) => {
  const fake = trackerManifestFake(manifest, { api, definitions })
  const call = serviceApiCall({
    manifest: api,
    service: "Tracker",
    fetch: fake.fetch,
    token: () => FAKE_MANIFEST_TOKEN,
  })
  const read = async (variables: Row, selection = `nodes { id updatedAt archivedAt } ${PAGE_INFO}`) =>
    (await call("issues", {
      path: {},
      query: {},
      headers: {},
      fields: {},
      body: JSON.stringify(variables),
      selection,
    })) as {
      nodes: Row[]
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
    }
  return { fake, read }
}

const issue = MANIFEST.entities.issue as NonNullable<TrackerManifest["entities"]["issue"]>
const withIssue = (change: Partial<typeof issue>) =>
  ({ ...MANIFEST, entities: { ...MANIFEST.entities, issue: { ...issue, ...change } } }) as TrackerManifest

const ids = (page: { nodes: Row[] }) => page.nodes.map((one) => one.id)

describe("trackerManifestContract over a Linear-shaped GraphQL schema", () => {
  for (const { name, run } of trackerManifestContract(MANIFEST, { api, definitions })) it(name, run)
})

describe("trackerManifestFake", () => {
  it("writes each row where the map reads it, pointing at the first row of the kind a field names", async () => {
    const { fake, read } = fakeOf()
    expect(fake.rows.issue?.[1]).toMatchObject({
      id: "issue-2",
      title: "title 2",
      state: { id: "state-1" },
      team: { id: "team-1" },
      assignee: { id: "user-1" },
      labels: { nodes: [{ id: "label-1" }] },
      archivedAt: null,
      updatedAt: "2026-11-01T10:01:00.000Z",
    })
    expect(fake.rows.state?.map((row) => row.type)).toEqual(["triage", "backlog", "unstarted"])
    expect((await read(ALL, `nodes { id state { id } } ${PAGE_INFO}`)).nodes[0]).toEqual({
      id: "issue-1",
      state: { id: "state-1" },
    })
  })

  it("pages two at a time by the cursor it gave, and refuses one it did not give", async () => {
    const { fake, read } = fakeOf()
    const first = await read({ first: 50, includeArchived: true })
    expect(ids(first)).toEqual(["issue-1", "issue-2"])
    expect(first.pageInfo).toEqual({ hasNextPage: true, endCursor: "fake-page-2" })
    const second = await read({ first: 50, includeArchived: true, after: first.pageInfo.endCursor })
    expect(ids(second)).toEqual(["issue-3"])
    expect(second.pageInfo).toEqual({ hasNextPage: false, endCursor: null })
    expect(fake.refusals).toEqual([])
    await expect(read({ first: 50, includeArchived: true, after: "o:2" })).rejects.toThrow()
    expect(fake.refusals).toEqual(["issues: o:2 is not a cursor this fake gave"])
  })

  it("hides an archived row unless the call asks for archived rows", async () => {
    const { fake, read } = fakeOf(withIssue({ ids: { ...issue.ids, variables: { first: 50 } } as typeof issue.ids }))
    fake.archive("issue", "issue-1")
    const shown = await read(ALL)
    expect(ids(shown)).toContain("issue-1")
    expect(typeof shown.nodes.find((one) => one.id === "issue-1")?.archivedAt).toBe("string")
    const hidden = await read({ first: 50 })
    expect(ids(hidden)).toEqual(["issue-2", "issue-3"])
    expect(hidden.pageInfo.hasNextPage).toBe(false)
  })

  it("keeps a change read to the rows changed at or after its since, oldest first", async () => {
    const { fake, read } = fakeOf()
    fake.touch("issue", "issue-1")
    const changes = { ...ALL, orderBy: "updatedAt" }
    const since = { ...changes, filter: { updatedAt: { gte: "2026-11-01T10:00:30Z" } } }
    const first = await read(since)
    expect([...ids(first), ...ids(await read({ ...since, after: first.pageInfo.endCursor }))]).toEqual([
      "issue-2",
      "issue-3",
      "issue-1",
    ])
    await expect(read({ ...changes, filter: { updatedAt: { gte: "yesterday" } } })).rejects.toThrow()
    expect(fake.refusals).toEqual(["issues: since yesterday is unreadable"])
  })

  it("refuses what the API would, and a call the manifest never makes", async () => {
    const { fake, read } = fakeOf()
    await expect(read({ first: 5, includeArchived: true }, `nodes { id estimate } ${PAGE_INFO}`)).rejects.toThrow()
    await expect(read({ first: 5 })).rejects.toThrow()
    expect(fake.refusals).toEqual([
      "issues.nodes.estimate: no such field",
      "issues: no call of the source manifest sends these variables",
    ])
  })

  it("writes a text field the schema keeps as an enum as one of its values", async () => {
    const project = MANIFEST.entities.project as NonNullable<TrackerManifest["entities"]["project"]>
    const selection = project.list.selection?.replace(" state ", " status { type } ")
    const { writes: _, ...reads } = MANIFEST
    const manifest = {
      ...reads,
      kinds: ["project"],
      entities: {
        project: {
          ...project,
          list: { ...project.list, selection },
          changes: { ...project.changes, selection },
          map: { ...project.map, status: "status.type" },
        },
      },
    } as unknown
    const { fake, source } = trackerManifestFixture(manifest, { api, definitions })
    expect(fake.rows.project?.[0]?.status).toEqual({ type: "backlog" })
    const listed = await source.changes("project", null)
    expect("items" in listed && listed.items[0]?.status).toBe("backlog")
    expect(fake.refusals).toEqual([])
  })

  it("fails to build for a kind with changes whose change time the map does not read", () => {
    const { updatedAt: _, ...map } = (MANIFEST.entities.issue as { map: Row }).map
    const manifest = { ...MANIFEST, entities: { ...MANIFEST.entities, issue: { ...MANIFEST.entities.issue, map } } }
    expect(() => trackerManifestFake(manifest as TrackerManifest, { api, definitions })).toThrow(/map updatedAt/)
  })
})

describe("a source the contract catches over the fake", () => {
  const failing = async (manifest: TrackerManifest, name: RegExp, message: RegExp) => {
    const found = trackerManifestContract(manifest, { api, definitions }).find((one) => name.test(one.name))
    expect(found).toBeDefined()
    await expect(found?.run()).rejects.toThrow(message)
  }
  const changes = issue.changes as NonNullable<typeof issue.changes>
  const since = (filter: Row) => withIssue({ changes: { ...changes, variables: { ...ALL, filter } } })

  it("an id pass that leaves archived rows out", async () => {
    await failing(
      withIssue({ ids: { ...issue.ids, variables: { first: 50 } } as typeof issue.ids }),
      /archived/,
      /issue issue-3: an archived row is still in ids\(\)/,
    )
  })

  it("a change read with no overlap, which loses a change when the clock runs ahead", async () => {
    await failing(
      { ...MANIFEST, overlapMs: 0 },
      /clock off/,
      /issue issue-1 is in the changes with the clock 10 min off/,
    )
  })

  it("a change read whose since is on another time, or reads before it", async () => {
    await failing(
      since({ createdAt: { gte: "{since}" } }),
      /clock off/,
      /the fake refused calls the source made:\nissues: \{since\} at filter\.createdAt\.gte is not updatedAt\.gte/,
    )
    await failing(
      since({ updatedAt: { lt: "{since}" } }),
      /clock off/,
      /the fake refused calls the source made:\nissues: \{since\} at filter\.updatedAt\.lt is not updatedAt\.gte/,
    )
  })

  it("an id pass or a change read that filters rows out", async () => {
    const ids = { ...issue.ids, variables: { ...ALL, filter: { state: { type: { neq: "canceled" } } } } }
    await failing(
      withIssue({ ids: ids as typeof issue.ids }),
      /^ids:/,
      /issues: a list or id read with a filter leaves rows out, and sync would mark them deleted/,
    )
    await failing(
      since({ updatedAt: { gte: "{since}" }, state: { type: { neq: "canceled" } } }),
      /clock off/,
      /issues: the fake cannot apply filter\.state\.type\.neq, so it would list rows the tracker drops/,
    )
  })

  it("a strict since leaves out a row changed at that very time", async () => {
    const { fake, read } = fakeOf(since({ updatedAt: { gt: "{since}" } }))
    const at = "2026-11-01T10:01:00.000Z"
    expect(ids(await read({ ...ALL, filter: { updatedAt: { gt: at } } }))).toEqual(["issue-3"])
    expect(fake.refusals).toEqual([])
  })

  it("a fixture over the fake offers every fault the manifest allows", () => {
    const { faults, held } = trackerManifestFixture(MANIFEST, { api, definitions })
    expect(Object.keys(faults ?? {}).sort()).toEqual(["archive", "change", "remove", "skewed"])
    expect(held?.comment).toEqual(["comment-1", "comment-2", "comment-3"])
  })
})

describe("a sync over the fake", () => {
  it("names the first user as the signed-in one, whose open issues become the owner's tasks", async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "tracker-fake-")), "store.db") })
    try {
      const { source, fake } = trackerManifestFixture(MANIFEST, { api, definitions })
      const report = await syncTracker(source, store, { provider: "tracker", account: "workspace" })
      expect(report.tasks).toEqual({ opened: 3, closed: 0, reopened: 0, renamed: 0 })
      const tasks = await store.tasks.query("tracker:workspace", undefined, { limit: 10, offset: 0 })
      expect(tasks.map((one) => one.title).sort()).toEqual(["key 1 title 1", "key 2 title 2", "key 3 title 3"])
      expect(fake.refusals).toEqual([])
    } finally {
      await store.close()
    }
  })
})
