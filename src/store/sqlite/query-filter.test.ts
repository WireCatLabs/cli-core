import { CliError } from "@wirecat/cli-base"
import { evaluate, type FieldSpec, type Predicate, parseLucene, validateQuery } from "@wirecat/cli-base/query"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { CacheDatabase } from "../driver.js"
import { openCache } from "../open.js"
import { type ColumnMap, queryFilter } from "./query-filter.js"

const FIELDS: FieldSpec[] = [
  { name: "state", type: "enum", operators: ["term"], values: ["open", "closed"], example: "state:open" },
  { name: "kind", type: "kw", operators: ["term", "phrase", "wildcard"], example: "kind:group" },
  { name: "chat", type: "ref", operators: ["term", "phrase"], example: 'chat:"chat:telegram/1"' },
  { name: "count", type: "num", operators: ["term", "range"], example: "count>0" },
  { name: "created_at", type: "time", operators: ["term", "range"], example: "created_at>=2026-01-01" },
  { name: "done", type: "bool", operators: ["term"], example: "done:true" },
  { name: "title", type: "txt", operators: ["term", "phrase"], example: "title:plan" },
  { name: "tag", type: "kw", operators: ["term"], example: "tag:work", relation: "the tags on it" },
]

interface Item {
  id: number
  state: string | null
  kind: string | null
  chat: string | null
  count: number | null
  created_at: string | null
  done: boolean | null
  title: string | null
  tags: string[]
}
const day = (date: string) => `${date}T12:00:00.000Z`
const ITEMS: Item[] = [
  {
    id: 1,
    state: "open",
    kind: "group",
    chat: "chat:telegram/1",
    count: 3,
    created_at: day("2026-01-01"),
    done: false,
    title: "Quarterly plan draft",
    tags: ["work"],
  },
  {
    id: 2,
    state: "closed",
    kind: "channel",
    chat: "chat:telegram/2",
    count: 0,
    created_at: day("2026-01-02"),
    done: true,
    title: "Plan",
    tags: [],
  },
  {
    id: 3,
    state: null,
    kind: "Group_A",
    chat: "CHAT:telegram/1",
    count: null,
    created_at: null,
    done: null,
    title: null,
    tags: ["home", "work"],
  },
  {
    id: 4,
    state: "open",
    kind: "dialog",
    chat: null,
    count: 10,
    created_at: day("2026-01-05"),
    done: true,
    title: "draft plan",
    tags: [],
  },
  {
    id: 5,
    state: "closed",
    kind: "",
    chat: "chat:max/9",
    count: 2,
    created_at: day("2026-01-03"),
    done: false,
    title: "100% done",
    tags: ["Work"],
  },
]

const COLUMNS: ColumnMap = {
  state: { type: "enum", sql: "state" },
  kind: { type: "kw", sql: "kind" },
  chat: { type: "ref", sql: "chat" },
  count: { type: "num", sql: "count" },
  created_at: { type: "time", sql: "created_at" },
  done: { type: "bool", sql: "done" },
  title: {
    where: (node: Predicate) => ({
      sql: "(' ' || lower(title) || ' ') LIKE ?",
      params: [`% ${node.value.toLowerCase()} %`],
    }),
  },
  tag: {
    where: (node: Predicate) => ({
      sql: "id IN (SELECT item FROM tags WHERE lower(tag) = ?)",
      params: [node.value.toLowerCase()],
    }),
  },
}

let database: CacheDatabase
beforeAll(async () => {
  database = await openCache(":memory:")
  database.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, state TEXT, kind TEXT, chat TEXT, count INTEGER,
    created_at INTEGER, done INTEGER, title TEXT); CREATE TABLE tags (item INTEGER, tag TEXT)`)
  for (const item of ITEMS) {
    database
      .prepare("INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        item.id,
        item.state,
        item.kind,
        item.chat,
        item.count,
        item.created_at === null ? null : Date.parse(item.created_at),
        item.done === null ? null : Number(item.done),
        item.title,
      )
    for (const tag of item.tags) database.prepare("INSERT INTO tags VALUES (?, ?)").run(item.id, tag)
  }
})
afterAll(() => database.close())

const registry = { entity: "item", backend: "sql" as const, fields: FIELDS }
const viaSql = (query: string): number[] => {
  const ast = validateQuery(parseLucene(query, { defaultField: "none" }), registry)
  const where = queryFilter(ast, COLUMNS, { zone: "UTC" })
  return database
    .prepare(`SELECT id FROM items WHERE ${where.sql} ORDER BY id`)
    .all(...where.params)
    .map((row) => Number(row.id))
}
const viaOracle = (query: string): number[] => {
  const ast = parseLucene(query, { defaultField: "none" })
  return ITEMS.filter((item) =>
    evaluate(ast, FIELDS, item as unknown as Record<string, unknown>, {
      zone: "UTC",
      relation: (node, one) =>
        (one as unknown as Item).tags.some((tag) => tag.toLowerCase() === node.value.toLowerCase()),
    }),
  ).map(({ id }) => id)
}

describe("a list query as SQL", () => {
  it.each([
    "state:open",
    "state:OPEN",
    "-state:open",
    "state:open OR kind:channel",
    "+state:open kind:channel",
    "(state:open OR state:closed) -kind:channel",
    "kind:group",
    "kind:gr*",
    "kind:group_?",
    "kind:*",
    "-kind:*",
    'chat:"chat:telegram/1"',
    "count>2",
    "count:[0 TO 3}",
    "count:2",
    "-count>2",
    "created_at>=2026-01-02",
    "created_at:2026-01-03",
    "created_at:[2026-01-01 TO 2026-01-03}",
    "done:true",
    "done:false",
    "-done:true",
    "title:plan",
    "tag:work",
    "tag:work -tag:home",
  ])("%s returns what the oracle returns", (query) => {
    expect(viaSql(query)).toEqual(viaOracle(query))
  })

  it("answers the fixtures it is compared on", () => {
    expect(viaSql("-state:open")).toEqual([2, 3, 5])
    expect(viaSql("kind:gr*")).toEqual([1, 3])
    expect(viaSql("created_at:[2026-01-01 TO 2026-01-03}")).toEqual([1, 2])
    expect(viaSql("tag:work -tag:home")).toEqual([1, 5])
  })

  it("binds every value, so a quote in the query never reaches the SQL text", () => {
    const where = queryFilter(parseLucene(`kind:"x' OR 1=1 --"`, { defaultField: "none" }), COLUMNS)
    expect(where.sql).not.toContain("1=1")
    expect(where.params).toEqual(["x' or 1=1 --"])
  })

  it("refuses a regular expression on a plain column", () => {
    const ast = parseLucene("kind:/gr.*/", { defaultField: "none" })
    expect(() => queryFilter(ast, COLUMNS, { command: "items list" })).toThrow(CliError)
  })
})
