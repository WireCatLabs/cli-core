import { type GraphqlFakeCall, graphqlFake, type Selection } from "@wirecat/cli-base/codegen"
import { describe, expect, it } from "vitest"
import { serviceApiCall } from "../../cli/service-api-call.js"
import type { TrackerKind } from "../../domain/tracker.js"
import { ALL, api, definitions, FIELDS, KEY, MANIFEST, PAGE_INFO, URL } from "../../testing/tracker-graphql.js"
import { trackerSourceContract } from "../testing/index.js"
import type { TrackerManifest } from "./manifest.js"
import { parseTrackerManifest } from "./manifest.js"
import { trackerSourceFromManifest } from "./source.js"

type Row = Record<string, unknown>

const project = (value: unknown, selection: Selection | true): unknown => {
  if (selection === true || value === null || value === undefined) return value ?? null
  if (Array.isArray(value)) return value.map((one) => project(one, selection))
  return Object.fromEntries(
    Object.entries(selection).map(([field, inner]) => [field, project((value as Row)[field], inner)]),
  )
}

const at = (ms: number) => new Date(ms).toISOString()
const SEEDED = Date.UTC(2026, 10, 1)
const ref1 = (id: string | null) => (id === null ? null : { id })

const seed = (): Record<TrackerKind, Row[]> => {
  const times = (n: number) => ({ createdAt: at(SEEDED), updatedAt: at(SEEDED + n * 1000), archivedAt: null })
  return {
    team: [
      { id: "t1", name: "Engineering", key: "ENG", ...times(1) },
      { id: "t2", name: "Design", key: "DES", ...times(2) },
      { id: "t3", name: "Support", key: "SUP", ...times(3) },
    ],
    user: [
      { id: "u1", name: "Ada", email: "ada@example.com", active: true, ...times(1) },
      { id: "u2", name: "Bob", email: "bob@example.com", active: true, ...times(2) },
      { id: "u3", name: "Cy", email: "cy@example.com", active: false, ...times(3) },
    ],
    state: [
      { id: "s1", name: "Todo", type: "unstarted", position: 1, team: ref1("t1"), ...times(1) },
      { id: "s2", name: "Doing", type: "started", position: 2, team: ref1("t1"), ...times(2) },
      { id: "s3", name: "Done", type: "completed", position: 3, team: ref1("t1"), ...times(3) },
    ],
    label: [
      { id: "l1", name: "Bug", team: ref1("t1"), ...times(1) },
      { id: "l2", name: "Feature", team: null, ...times(2) },
      { id: "l3", name: "Chore", team: ref1("t2"), ...times(3) },
    ],
    project: [1, 2, 3].map((n) => ({
      id: `p${n}`,
      name: `Project ${n}`,
      description: null,
      state: "started",
      lead: ref1("u1"),
      teams: { nodes: [{ id: "t1" }] },
      targetDate: "2026-12-31",
      url: `https://tracker.example/p${n}`,
      ...times(n),
    })),
    issue: [1, 2, 3].map((n) => ({
      id: `i${n}`,
      identifier: `ENG-${n}`,
      title: `Issue ${n}`,
      description: null,
      state: ref1("s1"),
      team: ref1("t1"),
      project: n === 3 ? null : ref1("p1"),
      assignee: n === 2 ? null : ref1("u1"),
      creator: ref1("u2"),
      labels: { nodes: n === 1 ? [{ id: "l1" }] : [] },
      parent: null,
      priority: n,
      dueDate: null,
      completedAt: null,
      canceledAt: null,
      url: `https://tracker.example/ENG-${n}`,
      ...times(n),
    })),
    comment: [1, 2, 3].map((n) => ({
      id: `c${n}`,
      body: `Comment ${n}`,
      issue: ref1("i1"),
      user: ref1("u2"),
      url: null,
      ...times(n),
    })),
  }
}

/** A tracker that pages by two, filters by `updatedAt.gte`, leaves archived rows out unless asked, and stamps changes. */
const tracker = (answers: Readonly<Record<string, (call: GraphqlFakeCall) => unknown>> = {}) => {
  const rows = seed()
  let tick = 0
  const clock = () => Date.now() + tick++ * 1000
  const list = (kind: TrackerKind) => (call: GraphqlFakeCall) => {
    const { first, after, filter, includeArchived } = call.variables as {
      first?: number
      after?: string | null
      filter?: { updatedAt?: { gte?: string } }
      includeArchived?: boolean
    }
    const since = filter?.updatedAt?.gte === undefined ? null : Date.parse(filter.updatedAt.gte)
    const listed = rows[kind]
      .filter((row) => includeArchived || row.archivedAt === null)
      .filter((row) => since === null || Date.parse(String(row.updatedAt)) >= since)
      .sort(
        (a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)) || String(a.id).localeCompare(String(b.id)),
      )
    const offset = after ? Number(after.slice(2)) : 0
    const size = Math.min(first ?? 50, 2)
    const more = offset + size < listed.length
    return {
      data: project(
        {
          nodes: listed.slice(offset, offset + size),
          pageInfo: { hasNextPage: more, endCursor: more ? `o:${offset + size}` : null },
        },
        call.selection ?? true,
      ),
    }
  }
  const fake = graphqlFake({
    operations: api.operations,
    definitions,
    url: URL,
    auth: { header: "authorization", value: KEY },
    answers: {
      ...Object.fromEntries((Object.keys(FIELDS) as TrackerKind[]).map((kind) => [FIELDS[kind][0], list(kind)])),
      viewer: () => ({ data: { id: "u1" } }),
      ...answers,
    },
  })
  const find = (kind: TrackerKind, id: string) => {
    const row = rows[kind].find((one) => one.id === id)
    if (!row) throw new Error(`no ${kind} ${id}`)
    return row
  }
  const call = serviceApiCall({ manifest: api, service: "Tracker", fetch: fake.fetch, token: () => KEY })
  const sourceAt = (skew = 0) => trackerSourceFromManifest(MANIFEST, { api, call, now: () => clock() + skew })
  return {
    rows,
    fake,
    sourceAt,
    touch(kind: TrackerKind, id: string) {
      find(kind, id).updatedAt = at(clock())
    },
    archive(kind: TrackerKind, id: string) {
      const row = find(kind, id)
      row.archivedAt = at(clock())
      row.updatedAt = row.archivedAt
    },
    remove(kind: TrackerKind, id: string) {
      rows[kind].splice(rows[kind].indexOf(find(kind, id)), 1)
    },
  }
}

describe("trackerSourceFromManifest over a Linear-shaped GraphQL fake", () => {
  for (const c of trackerSourceContract(() => {
    const one = tracker()
    return {
      source: one.sourceAt(),
      held: Object.fromEntries(
        (Object.keys(FIELDS) as TrackerKind[]).map((kind) => [kind, one.rows[kind].map((row) => String(row.id))]),
      ),
      deadCursor: { kind: "issue", cursor: "not a time" },
      faults: {
        skewed: (ms) => one.sourceAt(ms),
        change: () => {
          one.touch("issue", "i2")
          return { kind: "issue", id: "i2" }
        },
        archive: () => {
          one.archive("issue", "i3")
          return { kind: "issue", id: "i3" }
        },
        remove: () => {
          one.remove("issue", "i3")
          return { kind: "issue", id: "i3" }
        },
      },
    }
  }))
    it(c.name, async () => {
      await c.run()
    })

  it("maps a row onto the tracker domain, reading a null object as none, and names the signed-in user", async () => {
    const one = tracker()
    const source = one.sourceAt()
    const page = await source.changes("issue", null)
    if ("reset" in page) throw new Error("a full list is never a reset")
    expect(page.items[0]).toEqual({
      externalId: "i1",
      createdAt: SEEDED,
      updatedAt: SEEDED + 1000,
      archivedAt: null,
      key: "ENG-1",
      title: "Issue 1",
      description: null,
      state: "s1",
      team: "t1",
      project: "p1",
      assignee: "u1",
      creator: "u2",
      labels: ["l1"],
      parent: null,
      priority: 1,
      dueDate: null,
      completedAt: null,
      canceledAt: null,
      url: "https://tracker.example/ENG-1",
    })
    expect(page.items[1]).toMatchObject({ externalId: "i2", assignee: null, labels: [] })
    expect(await source.self?.()).toBe("u1")
    expect(one.fake.refusals).toEqual([])
  })
})

describe("an optional kind", () => {
  const refused = () => ({ errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }] })
  const optional = {
    ...MANIFEST,
    entities: { ...MANIFEST.entities, comment: { ...MANIFEST.entities.comment, optional: { message: "no comments" } } },
  } as TrackerManifest

  it("is a gap when the tracker refuses it in errors[], for its changes and its ids, and the others still read", async () => {
    const one = tracker({ [FIELDS.comment[0]]: refused })
    const call = serviceApiCall({ manifest: api, service: "Tracker", fetch: one.fake.fetch, token: () => KEY })
    const source = trackerSourceFromManifest(optional, { api, call })
    const gaps: unknown[] = []
    const context = { spend: () => undefined, gap: (gap: unknown) => gaps.push(gap) }
    expect(await source.changes("comment", null, undefined, context)).toEqual({
      items: [],
      hasMore: false,
      cursor: null,
    })
    expect(await source.ids("comment", undefined, context)).toEqual({ items: [], hasMore: false })
    expect(gaps).toEqual([
      { kind: "comment", message: "no comments" },
      { kind: "comment", message: "no comments" },
    ])
    const issues = await source.changes("issue", null, undefined, context)
    expect("items" in issues && issues.items.length).toBe(2)
  })

  it("is an error when the kind is not optional", async () => {
    const one = tracker({ [FIELDS.comment[0]]: refused })
    await expect(one.sourceAt().changes("comment", null)).rejects.toMatchObject({ code: "permission_error" })
  })
})

describe("parseTrackerManifest", () => {
  const broken = (change: (manifest: Row) => void) => {
    const copy = structuredClone({ ...MANIFEST }) as unknown as Row
    change(copy)
    return () => parseTrackerManifest(copy, api)
  }
  const issue = (manifest: Row) => (manifest.entities as Record<string, Row>).issue as Row

  it("refuses a map path the selection leaves out", () => {
    expect(
      broken((manifest) => {
        ;(issue(manifest).list as Row).selection = `nodes { id title } ${PAGE_INFO}`
      }),
    ).toThrow(/entities\.issue\.list\.selection: map\.createdAt reads createdAt, which the selection leaves out/)
  })

  it("refuses a selection GraphQL could not send", () => {
    expect(
      broken((manifest) => {
        ;(issue(manifest).list as Row).selection = "nodes { id title(first: 2) }"
      }),
    ).toThrow(/entities\.issue\.list\.selection/)
  })

  it("names a mistyped operation and field, and a change call without {since}", () => {
    expect(
      broken((manifest) => {
        ;(issue(manifest).list as Row).operation = "isues"
      }),
    ).toThrow(/no operation isues in the API; did you mean issues\?/)
    expect(
      broken((manifest) => {
        ;(issue(manifest).map as Row).titel = "title"
      }),
    ).toThrow(/issue has no such field; did you mean title\?/)
    expect(
      broken((manifest) => {
        ;(issue(manifest).changes as Row).variables = ALL
      }),
    ).toThrow(/no "\{since\}"/)
  })

  it("checks the signed-in user's path against the selection", () => {
    expect(
      broken((manifest) => {
        ;(manifest.self as Row).path = "viewer.id"
      }),
    ).toThrow(/self\.call\.selection: map\.self reads viewer\.id/)
  })

  it("refuses kinds out of order", () => {
    expect(
      broken((manifest) => {
        manifest.kinds = ["issue", "team"]
      }),
    ).toThrow(/in this order/)
  })
})
