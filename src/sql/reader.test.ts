import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Duplex } from "node:stream"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RequestEvent } from "../runs/events.js"
import { openSqlReader, quoteSql, type SqlDriver, type SqlOptions, type SqlRow, sqlFailure } from "./index.js"

const PASSWORD = "secret-marker-db"

const mysqlSeen = vi.hoisted(() => ({ config: undefined as unknown, statements: [] as string[] }))
const pgSeen = vi.hoisted(() => ({ config: undefined as unknown }))

vi.mock("mysql2/promise", () => ({
  createConnection: async (config: unknown) => {
    mysqlSeen.config = config
    return {
      query: async (statement: string | { sql: string }) => {
        mysqlSeen.statements.push(typeof statement === "string" ? statement : statement.sql)
        return [[], []]
      },
      end: async () => undefined,
    }
  },
}))

vi.mock("pg", () => ({
  default: {
    types: { getTypeParser: () => (value: string) => `parsed:${value}` },
    Client: class {
      constructor(config: unknown) {
        pgSeen.config = config
      }
      connect = async () => undefined
      query = async () => ({ rows: [], fields: [] })
      end = async () => undefined
    },
  },
}))

beforeEach(() => {
  mysqlSeen.config = undefined
  mysqlSeen.statements = []
  pgSeen.config = undefined
})

/** A table of `count` rows, `id` 1…count, answered as a server would answer the reader's SELECT. */
const table = (count: number, { repeatTime = false } = {}) => {
  const rows: SqlRow[] = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    calldate: repeatTime ? "2026-11-01 10:00:00" : `2026-11-01 10:${String(index).padStart(2, "0")}:00`,
  }))
  const statements: { sql: string; params: readonly unknown[] }[] = []
  const driver: SqlDriver = {
    columns: async () => [
      { name: "id", zoned: false },
      { name: "calldate", zoned: false },
    ],
    query: async (sql, params) => {
      statements.push({ sql, params })
      const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1])
      const offset = Number(/OFFSET (\d+)/.exec(sql)?.[1] ?? 0)
      const after = /\) > \(/.test(sql) ? Number(params.at(-1)) : 0
      return rows.filter((row) => Number(row.id) > after).slice(offset, offset + limit)
    },
    close: async () => undefined,
  }
  return { driver, statements }
}

const open = (driver: SqlDriver, extra: Partial<SqlOptions> = {}) => {
  const events: RequestEvent[] = []
  const reader = openSqlReader({
    kind: "postgres",
    host: "pbx.example",
    database: "asteriskcdrdb",
    user: "reader",
    password: PASSWORD,
    events: (event) => events.push(event),
    driver: async () => driver,
    ...extra,
  })
  return { reader, events }
}

const all = async (pages: AsyncIterable<SqlRow[]>) => {
  const seen: SqlRow[][] = []
  for await (const page of pages) seen.push(page)
  return seen
}

describe("openSqlReader", () => {
  it("**pages by the last row's key when the order is unique**, with values only as parameters", async () => {
    const { driver, statements } = table(5)
    const reader = await open(driver).reader

    const pages = await all(
      reader.pages({
        table: "public.cdr",
        where: [{ column: "calldate", op: ">=", value: "2026-11-01 00:00:00" }],
        orderBy: ["id"],
        unique: true,
        pageSize: 2,
      }),
    )

    expect(pages.map((page) => page.map(({ id }) => id))).toEqual([[1, 2], [3, 4], [5]])
    expect(statements[0]).toEqual({
      sql: 'SELECT * FROM "public"."cdr" WHERE "calldate" >= $1 ORDER BY "id" LIMIT 2',
      params: ["2026-11-01 00:00:00"],
    })
    expect(statements[1]).toEqual({
      sql: 'SELECT * FROM "public"."cdr" WHERE "calldate" >= $1 AND ("id") > ($2) ORDER BY "id" LIMIT 2',
      params: ["2026-11-01 00:00:00", 2],
    })
  })

  it("pages by offset when the order is not unique, and quotes for MySQL", async () => {
    const { driver, statements } = table(3, { repeatTime: true })
    const reader = await open(driver, { kind: "mysql" }).reader

    const pages = await all(reader.pages({ table: "cdr", orderBy: ["calldate"], pageSize: 2 }))

    expect(pages.flat()).toHaveLength(3)
    expect(statements.map(({ sql }) => sql)).toEqual([
      "SELECT * FROM `cdr` ORDER BY `calldate` LIMIT 2 OFFSET 0",
      "SELECT * FROM `cdr` ORDER BY `calldate` LIMIT 2 OFFSET 2",
    ])
    expect(reader.placeholder(3)).toBe("?")
  })

  it("**refuses a name that is not an identifier** before anything reaches the server", async () => {
    const { driver, statements } = table(1)
    const reader = await open(driver).reader

    await expect(all(reader.pages({ table: "cdr; DROP TABLE cdr", orderBy: ["id"] }))).rejects.toMatchObject({
      details: { reason: "sql.bad-identifier" },
    })
    expect(() => quoteSql("postgres", 'a"b')).toThrow("letters, digits")
    expect(statements).toEqual([])
  })

  it("**traces each connect and page without the statement, the values or the password**", async () => {
    const { driver } = table(3)
    const { reader, events } = open(driver)

    await all((await reader).pages({ table: "cdr", orderBy: ["id"], unique: true, pageSize: 2 }))

    expect(events.filter((one) => one.event === "response").map((one) => [one.operation, one.counts])).toEqual([
      ["sql.connect", undefined],
      ["sql.rows", { rows: 2 }],
      ["sql.rows", { rows: 1 }],
    ])
    expect(events[0]).toMatchObject({ transport: "sql", level: "wire" })
    const trace = JSON.stringify(events)
    for (const hidden of ["SELECT", "cdr", PASSWORD, "asteriskcdrdb"]) expect(trace).not.toContain(hidden)
  })

  it("stops between pages on the run's signal", async () => {
    const controller = new AbortController()
    const { driver } = table(5)
    const reader = await open(driver, { signal: controller.signal }).reader
    const pages = reader.pages({ table: "cdr", orderBy: ["id"], unique: true, pageSize: 2 })[Symbol.asyncIterator]()

    await pages.next()
    controller.abort()

    await expect(pages.next()).rejects.toMatchObject({ code: "cancelled" })
  })

  it("reads the columns, with PostgreSQL's zone, from an empty read", async () => {
    const reader = await open({
      ...table(0).driver,
      columns: async (sql) => {
        expect(sql).toBe('SELECT * FROM "cdr" LIMIT 0')
        return [{ name: "calldate", zoned: true }]
      },
    }).reader

    expect(await reader.columns("cdr")).toEqual([{ name: "calldate", zoned: true }])
  })

  it("**opens the host's stream first and hands it to the driver**, for a database behind an SSH tunnel", async () => {
    const stream = new Duplex({ read() {}, write: (_chunk, _encoding, done) => done() })
    const given = vi.fn(async (_options: SqlOptions, socket: Duplex | undefined) => {
      expect(socket).toBe(stream)
      return table(0).driver
    })

    await openSqlReader({
      kind: "mysql",
      host: "pbx.example",
      database: "asteriskcdrdb",
      user: "reader",
      password: PASSWORD,
      socket: async () => stream,
      driver: given,
    })

    expect(given).toHaveBeenCalledOnce()
  })
})

describe("the drivers", () => {
  const options = { host: "pbx.example", database: "asteriskcdrdb", user: "reader", password: PASSWORD, tls: true }

  it("**opens MySQL read-only**, with wall-time dates, a checked certificate and the tunnel's stream", async () => {
    const stream = new Duplex({ read() {}, write: (_chunk, _encoding, done) => done() })

    await openSqlReader({ ...options, kind: "mysql", socket: async () => stream })

    expect(mysqlSeen.statements[0]).toBe("SET SESSION TRANSACTION READ ONLY")
    expect(mysqlSeen.config).toMatchObject({
      host: "pbx.example",
      port: 3306,
      dateStrings: true,
      ssl: { rejectUnauthorized: true },
      stream,
    })
  })

  it("**opens PostgreSQL read-only**, keeping a time without a zone as its text", async () => {
    await openSqlReader({ ...options, kind: "postgres", port: 6543 })
    const config = pgSeen.config as {
      options: string
      port: number
      ssl: unknown
      stream?: unknown
      types: { getTypeParser(oid: number): (value: string) => unknown }
    }

    expect(config).toMatchObject({
      port: 6543,
      options: "-c default_transaction_read_only=on",
      ssl: { rejectUnauthorized: true, servername: "pbx.example" },
    })
    expect(config.stream).toBeUndefined()
    expect(config.types.getTypeParser(1114)("2026-11-01 10:00:00")).toBe("2026-11-01 10:00:00")
    expect(config.types.getTypeParser(1184)("2026-11-01 10:00:00+00")).toBe("parsed:2026-11-01 10:00:00+00")
  })
})

describe("sqlFailure", () => {
  it.each([
    ["ER_ACCESS_DENIED_ERROR", "authentication_error", "db.refused"],
    ["28P01", "authentication_error", "db.refused"],
    ["3D000", "not_found", "db.no-database"],
    ["ER_NO_SUCH_TABLE", "not_found", "db.no-table"],
    ["42501", "permission_error", "db.no-select"],
    ["25006", "permission_error", "db.read-only"],
    ["ECONNREFUSED", "network_error", "network.failed"],
    ["57014", "timeout", "db.timeout"],
  ])("maps %s without the driver's text", (code, expected, reason) => {
    const error = Object.assign(new Error(`password ${PASSWORD} for reader@pbx.example`), { code })
    const failure = sqlFailure("postgres", error)

    expect([failure.code, failure.details.reason]).toEqual([expected, reason])
    expect(failure.message).not.toContain(PASSWORD)
    expect(failure.message).not.toContain("reader@")
  })
})

describe("the driver boundary", () => {
  it("is imported only by the reader", () => {
    const root = join(import.meta.dirname, "..")
    const importers = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) =>
        /from "(pg|mysql2[^"]*)"|import\("(pg|mysql2[^"]*)"\)/.test(readFileSync(join(root, name), "utf8")),
      )
    expect(importers).toEqual([join("sql", "reader.ts")])
  })
})
